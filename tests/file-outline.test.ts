import { describe, expect, it } from 'vitest';
import { countFileSymbols, formatOutline, toFileSymbols } from '../src/shared/lsp-symbols';

/**
 * Скелет файла: ответ `textDocument/documentSymbol` в строки с номерами.
 * На этом строится инструмент `file_outline`: агент узнаёт устройство файла,
 * не читая его целиком, и дальше запрашивает нужные строки диапазоном.
 *
 * Отдельным файлом от `lsp-symbols.test.ts` — там разбор «где объявлено имя»
 * для поиска по проекту, здесь устройство одного файла. Это разные задачи,
 * и путать их в одном описании было бы неудобно.
 */
describe('toFileSymbols', () => {
  it('разбирает DocumentSymbol: вложенность, строки, вид', () => {
    const raw = [
      {
        name: 'Parser',
        kind: 5,
        range: { start: { line: 2, character: 0 }, end: { line: 40, character: 0 } },
        selectionRange: { start: { line: 2, character: 6 }, end: { line: 2, character: 12 } },
        children: [
          { name: 'parse', kind: 6, range: { start: { line: 4, character: 2 }, end: { line: 9, character: 0 } } },
        ],
      },
    ];

    expect(toFileSymbols(raw)).toEqual([
      {
        name: 'Parser',
        kind: 'класс',
        line: 3,
        endLine: 40,
        children: [{ name: 'parse', kind: 'метод', line: 5, endLine: 9, children: [] }],
      },
    ]);
  });

  it('понимает плоский SymbolInformation с location', () => {
    const raw = [{ name: 'readFile', kind: 12, location: { range: { start: { line: 43 } } } }];

    expect(toFileSymbols(raw)).toEqual([{ name: 'readFile', kind: 'функция', line: 44, endLine: 44, children: [] }]);
  });

  it('символ в первой строке не съезжает на вторую', () => {
    // Ловушка нулевой строки: 0-based ноль — это первая строка, а не «пусто».
    const raw = [{ name: 'x', kind: 13, range: { start: { line: 0 }, end: { line: 1 } } }];

    expect(toFileSymbols(raw)[0]).toMatchObject({ line: 1, endLine: 1 });
  });

  it('без конца диапазона символ считается однострочным', () => {
    const raw = [{ name: 'x', kind: 13, range: { start: { line: 9 } } }];

    expect(toFileSymbols(raw)[0]).toMatchObject({ line: 10, endLine: 10 });
  });

  it('мусор в ответе пропускается, а не ломает разбор', () => {
    expect(toFileSymbols([null, {}, { name: '' }, { name: 'ok', kind: 12, range: { start: { line: 1 } } }])).toEqual([
      { name: 'ok', kind: 'функция', line: 2, endLine: 2, children: [] },
    ]);
    expect(toFileSymbols('не массив')).toEqual([]);
  });

  it('битые дети не мешают остальным', () => {
    const raw = [
      { name: 'a', kind: 5, range: { start: { line: 0 } }, children: [null, { name: 'b', kind: 6, range: {} }] },
    ];

    expect(toFileSymbols(raw)[0]?.children).toEqual([]);
  });
});

describe('countFileSymbols', () => {
  it('считает и вложенные объявления', () => {
    const symbols = toFileSymbols([
      {
        name: 'A',
        kind: 5,
        range: { start: { line: 0 }, end: { line: 9 } },
        children: [{ name: 'm', kind: 6, range: { start: { line: 1 }, end: { line: 2 } } }],
      },
      { name: 'f', kind: 12, range: { start: { line: 12 }, end: { line: 14 } } },
    ]);

    expect(countFileSymbols(symbols)).toBe(3);
  });
});

describe('formatOutline', () => {
  const symbols = toFileSymbols([
    {
      name: 'Parser',
      kind: 5,
      range: { start: { line: 2, character: 0 }, end: { line: 40, character: 0 } },
      children: [{ name: 'parse', kind: 6, range: { start: { line: 4 }, end: { line: 6 } } }],
    },
    { name: 'readFile', kind: 12, range: { start: { line: 43 }, end: { line: 43 } } },
  ]);

  it('печатает объявления с номерами строк, вложенные — с отступом', () => {
    const { detail, summary, total, lines } = formatOutline('src/parser.py', symbols, { totalLines: 60 });

    expect(detail.split('\n')).toEqual([
      'Скелет src/parser.py: 3 объявления из 60 строк',
      '3–40: класс Parser',
      '  5–6: метод parse',
      '44: функция readFile',
      '',
      'Тела не показаны: нужные строки читай диапазоном (read_file с startLine и endLine).',
    ]);
    expect(summary).toBe('parser.py: 3 объявления');
    expect(total).toBe(3);
    expect(lines).toBe(3);
  });

  it('одиночная строка показывается одним числом, а не диапазоном', () => {
    expect(formatOutline('a.py', symbols).detail).toContain('\n44: функция readFile');
  });

  it('сводка согласована по числу', () => {
    const one = toFileSymbols([{ name: 'f', kind: 12, range: { start: { line: 0 }, end: { line: 2 } } }]);

    expect(formatOutline('a.py', one).summary).toBe('a.py: 1 объявление');
    expect(formatOutline('a.py', []).summary).toBe('a.py: объявлений нет');
  });

  it('файл без объявлений объясняет, что делать', () => {
    const { detail, summary, total } = formatOutline('notes.txt', []);

    expect(summary).toBe('notes.txt: объявлений нет');
    expect(detail).toContain('Объявлений в notes.txt не нашлось');
    expect(detail).toContain('read_file');
    expect(total).toBe(0);
  });

  it('длинный скелет обрезается и говорит, сколько не показал', () => {
    const many = toFileSymbols(
      Array.from({ length: 30 }, (_, index) => ({ name: `f${index}`, kind: 12, range: { start: { line: index } } })),
    );
    const { detail, lines, total } = formatOutline('big.py', many, { maxLines: 10 });

    expect(lines).toBe(10);
    expect(total).toBe(30);
    expect(detail).toContain('показано 10 из 30');
    expect(detail).not.toContain('Тела не показаны');
  });
});
