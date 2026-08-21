import { net, session, type Session } from 'electron';
import { RELEASES_API_URL, type UpdateStatus } from '@shared/ipc.js';
import { ok, type IpcResult } from '@shared/result.js';
import { appVersion } from '../appVersion.js';
import { log } from '../logger.js';

/**
 * "Is there a newer Litho than the one you are running?"
 *
 * Deliberately *not* an auto-updater. The app is distributed as an AppImage, a
 * .deb and a couple of Windows builds from one static page, and each of those
 * is installed a different way - a downloader that guessed wrong would be worse
 * than useless. So this only ever *reads* a version number and tells the user
 * where to get the new build; the download stays a normal click on a normal
 * page in their own browser.
 *
 * The endpoint answers with one object per platform, each carrying the newest
 * version it holds (`verL` for Linux, `verW` for Windows). Only the entry for
 * the platform we are running on is consulted: a Linux user learns nothing
 * useful from a Windows build appearing first.
 *
 * Every failure - no network, DNS down, the server returning HTML, a malformed
 * payload - resolves to "no update known" rather than an error the user has to
 * dismiss. Being offline is the normal state of a laptop on a train, not a
 * fault worth interrupting anybody for.
 */

/** Hard cap on the request; a hung socket must never delay the app's startup. */
const REQUEST_TIMEOUT_MS = 8000;
/** The payload is a few kB of JSON; anything far larger is not our API. */
const MAX_RESPONSE_BYTES = 512 * 1024;

/**
 * The check runs in a session of its own, not the app's.
 *
 * `blockRemoteRequests` in main.ts cancels every outbound HTTP request on the
 * default session - that is the editor's offline-by-default policy and the
 * reason a compromised renderer cannot phone home. A main-process `net.request`
 * goes through that same session and was duly blocked
 * (`net::ERR_BLOCKED_BY_CLIENT`), so the check never got an answer.
 *
 * Widening the block list would have been the wrong repair: it would open a
 * hole the renderer can reach through. A separate partition carries none of the
 * default session's request handlers, so the one request this file makes gets
 * out while the editor's policy stays exactly as strict as it was. Cookies and
 * cache are off - there is no state to keep for a single GET of a version
 * number.
 */
const UPDATE_PARTITION = 'litho-update';

let updateSession: Session | null = null;

function getUpdateSession(): Session {
  if (!updateSession) updateSession = session.fromPartition(UPDATE_PARTITION, { cache: false });
  return updateSession;
}

/**
 * Where to ask. The constant is the answer in every shipped build; the
 * environment variable exists so the check can be pointed at a local stub in
 * tests (and so anyone mirroring the download page can repoint it) without a
 * second code path that then goes untested.
 */
function releasesUrl(): string {
  const override = process.env.LITHO_RELEASES_URL?.trim();
  return override ? override : RELEASES_API_URL;
}

export async function checkForUpdate(): Promise<IpcResult<UpdateStatus>> {
  const current = appVersion();
  const platformKey = process.platform === 'win32' ? 'windows' : 'linux';
  const versionKey = process.platform === 'win32' ? 'verW' : 'verL';

  let payload: unknown;
  try {
    payload = await fetchJson(releasesUrl());
  } catch (error) {
    // Offline is not an error the user needs to see; the banner simply never
    // appears and the next launch tries again.
    log.info(`[update] check skipped: ${String(error)}`);
    return ok({ current, latest: null, updateAvailable: false, checked: false });
  }

  const latest = readVersion(payload, platformKey, versionKey);
  if (latest === null) {
    log.warn('[update] releases payload had no usable version for this platform');
    return ok({ current, latest: null, updateAvailable: false, checked: true });
  }

  const updateAvailable = compareVersions(latest, current) > 0;
  log.info(`[update] current=${current} latest=${latest} newer=${updateAvailable}`);
  return ok({ current, latest, updateAvailable, checked: true });
}

/** Pulls `<platform>.<versionKey>` out of the payload, tolerating anything else. */
function readVersion(payload: unknown, platformKey: string, versionKey: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const platform = (payload as Record<string, unknown>)[platformKey];
  if (typeof platform !== 'object' || platform === null) return null;
  const raw = (platform as Record<string, unknown>)[versionKey];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return /^\d+(\.\d+)*$/u.test(trimmed) ? trimmed : null;
}

/**
 * Numeric, segment-by-segment comparison - `1.0.10` is newer than `1.0.9`, which
 * a string comparison gets backwards. Missing segments count as zero, so `1.1`
 * and `1.1.0` are the same version.
 */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * A single GET over Electron's own `net` stack rather than `fetch`, so the
 * request honours the system proxy the user's desktop is configured with -
 * which is the difference between "works" and "times out" on a corporate or
 * school network.
 */
function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: 'GET',
      url,
      session: getUpdateSession(),
      useSessionCookies: false,
    });
    // The endpoint sits behind Cloudflare, which challenges requests that do not
    // look like a browser. Electron's own User-Agent already carries a Chrome
    // token, and asking explicitly for JSON keeps an HTML challenge page from
    // being mistaken for a payload - it fails the parse and the check simply
    // reports "nothing known", which is the right outcome either way.
    request.setHeader('Accept', 'application/json');
    let settled = false;
    const finish = (error: Error | null, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      request.abort();
      finish(new Error('przekroczono czas oczekiwania'));
    }, REQUEST_TIMEOUT_MS);

    request.on('response', (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        request.abort();
        finish(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          request.abort();
          finish(new Error('odpowiedź jest zbyt duża'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          finish(new Error(`nieprawidłowy JSON: ${String(error)}`));
        }
      });
      response.on('error', (error: Error) => finish(error));
    });

    request.on('error', (error) => finish(error));
    request.end();
  });
}
