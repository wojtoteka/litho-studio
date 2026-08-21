/**
 * Downloads Material Symbols (Outlined) icon geometry from Google's static CDN
 * and emits `src/lib/icons.ts` - a name → SVG path-data map.
 *
 * Run once; the generated file is committed so the app never needs the network.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src/lib/icons.ts');
const BASE = 'https://fonts.gstatic.com/s/i/short-term/release/materialsymbolsoutlined';

const NAMES = [
  'add',
  'add_circle',
  'arrow_back',
  'arrow_drop_down_circle',
  'attach_file',
  'bar_chart',
  'bolt',
  'call_split',
  'check',
  'check_box',
  'check_circle',
  'chevron_right',
  'close',
  'cloud_done',
  'code',
  'collections',
  'contact_mail',
  'content_copy',
  'content_cut',
  'content_paste',
  'crop_square',
  'dark_mode',
  'dashboard_customize',
  'delete',
  'delete_sweep',
  'description',
  'download',
  'draft',
  'drag_indicator',
  'edit',
  'emoji_symbols',
  'error',
  'expand_less',
  'expand_more',
  'filter_center_focus',
  'fit_screen',
  'folder',
  'folder_open',
  'format_list_bulleted',
  'format_quote',
  'fullscreen',
  'grid_4x4',
  'height',
  'help',
  'horizontal_rule',
  'image',
  'info',
  'keyboard',
  'layers',
  'library_add',
  'light_mode',
  'link',
  'list_alt',
  'location_on',
  'lock',
  'lock_open',
  'menu',
  'monitor',
  'more_horiz',
  'movie',
  'music_note',
  'note_add',
  'notes',
  'open_in_new',
  'open_with',
  'palette',
  'payments',
  'pending',
  'power_settings_new',
  'radio_button_checked',
  'redo',
  'refresh',
  'remove',
  'restart_alt',
  'save',
  'search',
  'select_all',
  'sell',
  'send',
  'smart_button',
  'smart_display',
  'star',
  'style',
  'sync',
  'terminal',
  'text_fields',
  'title',
  'toggle_on',
  'tune',
  'undo',
  'upload_file',
  'view_agenda',
  'visibility',
  'visibility_off',
  'warning',
  'web',
  'widgets',
  'zoom_in',
  'zoom_out',
];

/** Pulls every `d="…"` out of an SVG document, in order. */
function extractPaths(svg) {
  return [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
}

const results = {};
const failed = [];

for (const name of NAMES) {
  const url = `${BASE}/${name}/default/24px.svg`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      failed.push(`${name} (HTTP ${response.status})`);
      continue;
    }
    const svg = await response.text();
    const paths = extractPaths(svg);
    if (paths.length === 0) {
      failed.push(`${name} (no path)`);
      continue;
    }
    results[name] = paths;
  } catch (error) {
    failed.push(`${name} (${error.message})`);
  }
}

const entries = Object.entries(results)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, paths]) => `  ${JSON.stringify(name)}: ${JSON.stringify(paths.join(' '))},`)
  .join('\n');

const file = `/**
 * Material Symbols (Outlined, 24 px) as raw SVG path data.
 *
 * The editor's own chrome must render identically with no network - Litho is an
 * offline desktop app and \`electron/main.ts\` blocks outbound requests by
 * design - so the icons are inlined as geometry rather than pulled from Google's
 * webfont CDN. That is also why they are \`<path>\` data and not an icon font:
 * no FOUT, no ligature text flashing in the toolbar, no extra request.
 *
 * Generated from https://fonts.google.com/icons (Material Symbols Outlined).
 * Icons the *user's page* uses still come from the CDN - see \`googleFonts.ts\`;
 * that is a property of the page being edited, not of the editor.
 */

export const ICON_PATHS = {
${entries}
} as const;

export type IconName = keyof typeof ICON_PATHS;
`;

// Run the project's own Prettier config over the output, so a regenerated
// icon set never shows up as a formatting diff.
const options = (await prettier.resolveConfig(OUT)) ?? {};
const formatted = await prettier.format(file, { ...options, filepath: OUT });

await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, formatted, 'utf8');

console.log(`OK: ${Object.keys(results).length} icons -> ${OUT}`);
if (failed.length > 0) console.log(`FAILED (${failed.length}): ${failed.join(', ')}`);
