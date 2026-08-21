import { describe, expect, it } from 'vitest';
import {
  buildElementScriptSnippet,
  CUSTOM_PRESET_ID,
  defaultParamsFor,
  ELEMENT_SCRIPT_PRESETS,
  elementScriptSnippetId,
  findPreset,
  parseElementScriptSnippet,
} from '@/engine/elementScripts.js';
import { parseManagedScript, renderManagedScript, upsertSnippet } from '@/engine/jsGenerator.js';

/**
 * The binding shown in the properties panel is *derived from the generated
 * file*, not stored anywhere else - so a full write/read round trip is the
 * behaviour that actually has to hold.
 */
function roundTrip(code: string, domId: string) {
  const script = parseManagedScript(code);
  const rendered = renderManagedScript(script);
  const reparsed = parseManagedScript(rendered);
  return reparsed.snippets.find((snippet) => snippet.id === elementScriptSnippetId(domId)) ?? null;
}

describe('element script presets', () => {
  it('every preset generates syntactically valid JavaScript', () => {
    for (const preset of ELEMENT_SCRIPT_PRESETS) {
      const snippet = buildElementScriptSnippet('cel', {
        presetId: preset.id,
        params: defaultParamsFor(preset),
      });
      expect(() => new Function(snippet.code)).not.toThrow();
    }
  });

  it('addresses the element by its id attribute', () => {
    const snippet = buildElementScriptSnippet('stopka-rok', {
      presetId: 'aktualny-rok',
      params: { rokStartowy: '2020', separator: '-', przedrostek: '© ', przyrostek: '' },
    });

    expect(snippet.id).toBe('element-script:stopka-rok');
    expect(snippet.code).toContain('document.getElementById("stopka-rok")');
    // A missing element must never throw: the user may delete it later.
    expect(snippet.code).toContain('if (!element) return;');
  });

  it('restores preset and parameters after a write/read round trip', () => {
    const snippet = buildElementScriptSnippet('licznik', {
      presetId: 'licznik-odliczania',
      params: { termin: '2026-12-24T18:00', tekstKoncowy: 'Wesołych Świąt!', przedrostek: 'Zostało ' },
    });

    const empty = parseManagedScript('const mine = 1;\n');
    const file = renderManagedScript(upsertSnippet(empty, snippet));
    const recovered = roundTrip(file, 'licznik');

    expect(recovered).not.toBeNull();
    const binding = parseElementScriptSnippet(recovered!);
    expect(binding).toEqual({
      presetId: 'licznik-odliczania',
      params: { termin: '2026-12-24T18:00', tekstKoncowy: 'Wesołych Świąt!', przedrostek: 'Zostało ' },
    });
  });

  it('round-trips hand-written code through the marker comments', () => {
    const code = [
      'element.style.color = "red";',
      'if (window.innerWidth < 600) {',
      '  element.hidden = true;',
      '}',
    ].join('\n');
    const snippet = buildElementScriptSnippet('baner', { presetId: CUSTOM_PRESET_ID, params: { kod: code } });
    const recovered = roundTrip(renderManagedScript(upsertSnippet(parseManagedScript(''), snippet)), 'baner');

    const binding = parseElementScriptSnippet(recovered!);
    expect(binding?.presetId).toBe(CUSTOM_PRESET_ID);
    expect(binding?.params.kod).toBe(code);
  });

  it('never leaves the user code duplicated in the config comment', () => {
    const snippet = buildElementScriptSnippet('baner', {
      presetId: CUSTOM_PRESET_ID,
      params: { kod: 'element.dataset.ready = "1";' },
    });
    const config = /\/\* litho-config: ([\s\S]*?)\*\//u.exec(snippet.code)?.[1] ?? '';

    expect(config).not.toContain('dataset');
    expect(JSON.parse(config.trim())).toEqual({ preset: CUSTOM_PRESET_ID, params: {} });
  });

  it('ignores a snippet that carries no readable config', () => {
    expect(
      parseElementScriptSnippet({ id: 'element-script:x', title: 'ręczny', code: 'console.log(1);' }),
    ).toBeNull();
  });

  it('keeps every preset id addressable', () => {
    for (const preset of ELEMENT_SCRIPT_PRESETS) {
      expect(findPreset(preset.id)).toBe(preset);
    }
    expect(findPreset('nie-ma-takiego')).toBeNull();
  });
});

/**
 * The in-panel preview is the only feedback the editor gives (the canvas runs
 * no scripts), so it must show *exactly* what the generated code produces -
 * these run the real generated body against a fake element and compare.
 */
describe('element script live preview', () => {
  function runBody(presetId: string, params: Record<string, string>): string {
    const preset = findPreset(presetId)!;
    const element = { textContent: '' };
    // eslint-disable-next-line no-new-func
    new Function('element', preset.build({ ...defaultParamsFor(preset), ...params }, 'x'))(element);
    return element.textContent;
  }

  it('year preview matches the code, and gives just the year when the prefix is cleared', () => {
    const preset = findPreset('aktualny-rok')!;
    const params = { rokStartowy: '', separator: '-', przedrostek: '', przyrostek: '' };

    const preview = preset.preview(params, '');
    expect(preview?.text).toBe(String(new Date().getFullYear()));
    expect(preview?.text).toBe(runBody('aktualny-rok', params));
  });

  it('year preview builds a range from the start year', () => {
    const preset = findPreset('aktualny-rok')!;
    const params = { rokStartowy: '2020', separator: '-', przedrostek: '© ', przyrostek: '' };
    expect(preset.preview(params, '')?.text).toBe(runBody('aktualny-rok', params));
  });

  it('date preview matches the code', () => {
    const preset = findPreset('aktualna-data')!;
    const params = { format: 'dlugi', jezyk: 'pl-PL', przedrostek: '', przyrostek: '' };
    expect(preset.preview(params, '')?.text).toBe(runBody('aktualna-data', params));
  });

  it('typewriter preview shows the element existing text', () => {
    const preset = findPreset('maszyna-do-pisania')!;
    expect(preset.preview({ tempo: '45' }, 'Witaj świecie')?.text).toBe('Witaj świecie');
  });

  it('counter preview shows the final value the animation lands on', () => {
    const preset = findPreset('licznik-liczb')!;
    const params = { wartosc: '1200', czas: '1600', separator: 'spacja', przedrostek: '', przyrostek: '' };

    // The generated code counts up over time; what it settles on is `render(target)`,
    // and that is what the panel promises.
    expect(preset.preview(params, '')?.text).toBe('1 200');
    expect(preset.preview({ ...params, separator: 'brak' }, '')?.text).toBe('1200');
    expect(preset.preview({ ...params, wartosc: '4,9' }, '')?.text).toBe('4,9');
    expect(preset.preview({ ...params, przedrostek: 'ponad ', przyrostek: ' zł' }, '')?.text).toBe(
      'ponad 1 200 zł',
    );
  });

  it('counter animation ends on exactly the previewed text', () => {
    const preset = findPreset('licznik-liczb')!;
    const params = { wartosc: '12500', czas: '400', separator: 'spacja', przedrostek: '', przyrostek: '+' };
    const element = { textContent: '' };

    // Run the real generated body with a clock we control: no observer, no
    // reduced-motion match, and frames we can drive to the end.
    const frames: Array<(now: number) => void> = [];
    const scope = {
      element,
      window: { matchMedia: () => ({ matches: false }) },
      requestAnimationFrame: (callback: (now: number) => void) => frames.push(callback),
      IntersectionObserver: undefined,
      Math,
      Number,
    };
    // eslint-disable-next-line no-new-func
    new Function(...Object.keys(scope), preset.build({ ...defaultParamsFor(preset), ...params }, 'x'))(
      ...Object.values(scope),
    );

    expect(element.textContent).toBe('0+'); // painted before the first frame
    let now = 0;
    while (frames.length > 0) {
      now += 100;
      frames.shift()!(now);
    }
    expect(element.textContent).toBe(preset.preview(params, '')?.text);
    expect(element.textContent).toBe('12 500+');
  });

  it('counter falls back to a valid number when the target is unusable', () => {
    const preset = findPreset('licznik-liczb')!;
    const snippet = buildElementScriptSnippet('stat', {
      presetId: 'licznik-liczb',
      params: { ...defaultParamsFor(preset), wartosc: 'sto', czas: '-5' },
    });
    expect(() => new Function(snippet.code)).not.toThrow();
    expect(snippet.code).toContain('var target = 0;');
    expect(snippet.code).toContain('var duration = 1600;'); // negative time ignored
  });

  it('has no preview for arbitrary user code', () => {
    expect(findPreset(CUSTOM_PRESET_ID)!.preview({ kod: 'x' }, '')).toBeNull();
  });

  it('every non-custom preset previews something for its defaults', () => {
    for (const preset of ELEMENT_SCRIPT_PRESETS) {
      if (preset.id === CUSTOM_PRESET_ID) continue;
      expect(preset.preview(defaultParamsFor(preset), 'przykład')).not.toBeNull();
    }
  });
});
