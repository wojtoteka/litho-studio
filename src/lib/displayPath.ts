/**
 * Turning an absolute filesystem path into something a person can read at a
 * glance, for the recent-projects list on the start screen.
 *
 * The list used to do this in CSS - `direction: rtl` plus an ellipsis, the
 * usual trick for truncating a path from the left. It is the wrong tool for a
 * POSIX path and it showed: bidi reordering moves the *leading* slash to the
 * far end, so `/home/ala/strona/index.html` was drawn as
 * `home/ala/strona/index.html/`. Every entry in the list looked subtly corrupt,
 * and the more nested the project, the worse it got.
 *
 * Doing it here instead costs one string operation per row and cannot reorder
 * anything, because the result is already in reading order by the time it
 * reaches the DOM. The full path still goes on the row's `title`, so nothing is
 * actually hidden from the user.
 */

/** Roughly how many characters of path a row can show before it must truncate. */
const DEFAULT_MAX = 58;

/** The horizontal ellipsis, not three periods - one glyph, and it kerns. */
const ELLIPSIS = '…';

function separatorOf(value: string): string {
  return value.includes('\\') && !value.includes('/') ? '\\' : '/';
}

/**
 * Replaces the home directory prefix with `~`.
 *
 * Only an exact segment match counts: `/home/ala` must not shorten
 * `/home/alan/site`, which a plain `startsWith` would happily do.
 */
export function collapseHome(value: string, homeDir: string): string {
  if (!homeDir) return value;

  const separator = separatorOf(value);
  const home = homeDir.replace(/[/\\]+$/u, '');
  if (value === home) return '~';
  if (!value.startsWith(home)) return value;

  const rest = value.slice(home.length);
  if (rest[0] !== '/' && rest[0] !== '\\') return value;
  return `~${separator}${rest.slice(1)}`;
}

/**
 * Drops leading path segments until what is left fits, prefixing `…/`.
 *
 * Truncating the *front* rather than the end is what keeps the useful half: two
 * sibling projects differ in their last segments, never in `/home/ala/`. The
 * final segment is always kept whole even when it alone is over budget - a row
 * reading `…` would tell the user nothing at all.
 */
export function shortenPath(value: string, maxChars = DEFAULT_MAX): string {
  if (value.length <= maxChars) return value;

  const separator = separatorOf(value);
  const segments = value.split(/[/\\]/u).filter((segment) => segment.length > 0);
  if (segments.length <= 1) return value;

  let kept = segments[segments.length - 1] as string;
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const candidate = `${segments[index] as string}${separator}${kept}`;
    // +2 for the "…" and the separator this prefix will be joined with.
    if (candidate.length + 2 > maxChars) break;
    kept = candidate;
  }

  return `${ELLIPSIS}${separator}${kept}`;
}

/** `collapseHome` then `shortenPath` - the order the two must be applied in. */
export function displayPath(value: string, homeDir: string, maxChars = DEFAULT_MAX): string {
  return shortenPath(collapseHome(value, homeDir), maxChars);
}

/**
 * "dzisiaj" / "wczoraj" / "3 dni temu" for a recent-projects timestamp.
 *
 * Compared by calendar day rather than by elapsed hours: something opened at
 * 23:00 yesterday should read "wczoraj" at 01:00 today, not "2 godziny temu".
 * Polish needs no plural branching here - `dni`, `tyg.` and `mies.` are the
 * right form for every count these buckets can produce.
 */
export function relativeDay(openedAt: number, now = Date.now()): string {
  const startOfDay = (value: number): number => {
    const date = new Date(value);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  };

  const days = Math.round((startOfDay(now) - startOfDay(openedAt)) / 86_400_000);

  if (days <= 0) return 'dzisiaj';
  if (days === 1) return 'wczoraj';
  if (days < 7) return `${days} dni temu`;
  if (days < 31) return `${Math.floor(days / 7)} tyg. temu`;
  if (days < 365) return `${Math.max(1, Math.floor(days / 30))} mies. temu`;
  return 'ponad rok temu';
}
