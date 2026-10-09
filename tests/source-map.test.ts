import { describe, expect, it } from 'vitest';
import { inlineSourceMap, SourceMap, sourceMappingUrlFromSource } from '../src/main/debug/source-map';

/**
 * Разбор source-карт: перевод позиций в обе стороны.
 *
 * Карта в тестах настоящая — собранная по формату вручную и проверенная сторонним
 * разборщиком как эталон формата. Она описывает реальный случай «TS собран в JS»:
 *
 * ```text
 * app.ts                       app.js
 * 1 function add(a: number…)   1 "use strict";
 * 2   const sum: number = …    2 function add(a, b) {
 * 3   return sum;              3   const sum = a + b;
 * 4 }                          4   return sum;
 * 5 console.log('result', …)   5 }
 *                              6 console.log('result', …)
 * ```
 *
 * Строки и колонки в модуле считаются с нуля (как в формате карты и в CDP), а
 * перевод в «человеческие» 1-based делает адаптер.
 */

/** Строка `mappings` карты выше: `;` — конец строки сгенерированного файла. */
const MAPPINGS = ';AAAA;EACE;EACA;AACF;AACA';
const MAP = { version: 3, file: 'app.js', sources: ['app.ts'], names: [], mappings: MAPPINGS };
const BASE = '/proj/build';
const SOURCE = '/proj/build/app.ts';

describe('SourceMap', () => {
  it('переводит исходник в сгенерированную позицию', () => {
    const map = SourceMap.fromJson(MAP, BASE);
    expect(map?.hasSource(SOURCE)).toBe(true);
    expect(map?.hasSource('/proj/build/other.ts')).toBe(false);

    // Строки исходника: 1 — заголовок функции, 2 — тело, 3 — возврат и так далее.
    expect(map?.generatedPositionFor(SOURCE, 0, 0)).toEqual({ line: 1, column: 0 });
    expect(map?.generatedPositionFor(SOURCE, 1, 0)).toEqual({ line: 2, column: 2 });
    expect(map?.generatedPositionFor(SOURCE, 3, 0)).toEqual({ line: 4, column: 0 });
    expect(map?.generatedPositionFor(SOURCE, 4, 0)).toEqual({ line: 5, column: 0 });

    // Незнакомый исходник и строка без кода — позиции нет, а не «первая попавшаяся».
    expect(map?.generatedPositionFor('/proj/build/other.ts', 0, 0)).toBeNull();
    expect(map?.generatedPositionFor(SOURCE, 20, 0)).toBeNull();
  });

  it('переводит сгенерированную позицию в исходник', () => {
    const map = SourceMap.fromJson(MAP, BASE);
    expect(map?.originalPositionFor(2, 2)).toEqual({ source: SOURCE, line: 1, column: 2, name: null });
    expect(map?.originalPositionFor(4, 0)).toEqual({ source: SOURCE, line: 3, column: 0, name: null });

    // Строка без сегментов (первая в файле) — перевода нет.
    expect(map?.originalPositionFor(0, 0)).toBeNull();
    // Колонка левее сегмента берётся из ближайшего справа по той же строке: место то же.
    expect(map?.originalPositionFor(3, 0)).toEqual({ source: SOURCE, line: 2, column: 2, name: null });
  });

  it('собирает путь исходника из sourceRoot', () => {
    const map = SourceMap.fromJson({ version: 3, sources: ['app.ts'], sourceRoot: '../src', mappings: 'AAAA' }, BASE);
    expect(map?.sources).toEqual(['/proj/src/app.ts']);
    expect(map?.hasSource('/proj/src/app.ts')).toBe(true);
  });

  it('разбирает многобайтовый VLQ', () => {
    // Сгенерированная колонка 100 кодируется двумя символами (`oG`).
    const map = SourceMap.fromJson({ version: 3, sources: ['a.ts'], mappings: 'oGAAA' }, BASE);
    expect(map?.generatedPositionFor(`${BASE}/a.ts`, 0, 0)).toEqual({ line: 0, column: 100 });
    expect(map?.originalPositionFor(0, 100)).toEqual({ source: `${BASE}/a.ts`, line: 0, column: 0, name: null });
  });

  it('на мусоре возвращает null, а не исключение', () => {
    expect(SourceMap.parse('{oops', BASE)).toBeNull();
    expect(SourceMap.parse('{"version":3}', BASE)).toBeNull();
    expect(SourceMap.parse('null', BASE)).toBeNull();
  });

  it('читает карту, вложенную в файл data-ссылкой', () => {
    const json = JSON.stringify(MAP);
    const url = `data:application/json;base64,${Buffer.from(json, 'utf8').toString('base64')}`;
    expect(inlineSourceMap(url)).toBe(json);

    const plain = 'data:application/json,{"version":3}';
    expect(inlineSourceMap(plain)).toBe('{"version":3}');

    // Ссылка на отдельный файл — не data, разбирает её адаптер.
    expect(inlineSourceMap('app.js.map')).toBeNull();
    expect(inlineSourceMap('file:///proj/app.js.map')).toBeNull();
  });

  it('находит ссылку на карту в комментарии', () => {
    expect(sourceMappingUrlFromSource('add(1, 2);\n//# sourceMappingURL=app.js.map\n')).toBe('app.js.map');
    expect(sourceMappingUrlFromSource('/*# sourceMappingURL=inline.js.map */')).toBe('inline.js.map');
    expect(sourceMappingUrlFromSource('const a = 1;')).toBeNull();
  });
});
