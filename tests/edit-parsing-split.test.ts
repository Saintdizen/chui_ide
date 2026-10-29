import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { combineOutcomes, parseEdits } from '../src/main/ai/edit-parsing';
import { normalizeWrite, wholeWrite } from '../src/main/ai/agent-edit';

/**
 * Граница `edit-parsing` — сторож на то, чего легко лишиться незаметно:
 * разбор правок должен понимать обе формы сразу, а `combineOutcomes` —
 * склеивать ответы нескольких файлов в один.
 */
describe('разбор правок отдельно от инструментов', () => {
  it('якорь: файл и замена в одном элементе', () => {
    const parsed = parseEdits([{ path: '/proj/a.ts', oldText: 'старое', newText: 'новое' }]);
    expect(parsed.positions).toHaveLength(0);
    expect(parsed.anchors).toHaveLength(1);
  });

  it('позиции: четыре границы без старого текста', () => {
    const parsed = parseEdits([
      {
        path: '/proj/a.ts',
        edits: [{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 5, newText: 'новое' }],
      },
    ]);
    expect(parsed.anchors).toHaveLength(0);
    expect(parsed.positions).toHaveLength(1);
  });

  it('адрес строками: startLine + endLine без столбцов — правка целыми строками', () => {
    // Столбцы модели пришлось бы считать на глаз — именно это и было промахом.
    // Номера строк даёт `read`, поэтому больше ничего не спрашиваем.
    const parsed = parseEdits([{ path: '/proj/a.ts', edits: [{ startLine: 12, endLine: 15, newText: 'новое' }] }]);
    const [edit] = parsed.positions[0]!.edits;
    expect(edit).toMatchObject({ startLine: 12, startColumn: 1, endLine: 15, newText: 'новое' });
    expect(edit!.endColumn).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('адрес строкой: одна startLine заменяет одну строку', () => {
    const parsed = parseEdits([{ path: '/proj/a.ts', edits: [{ startLine: 7, newText: 'x' }] }]);
    const [edit] = parsed.positions[0]!.edits;
    expect(edit).toMatchObject({ startLine: 7, endLine: 7, startColumn: 1 });
  });

  it('адрес наоборот — отказ словами, а не молчаливая правка не туда', () => {
    expect(() => parseEdits([{ path: '/proj/a.ts', edits: [{ startLine: 9, endLine: 3, newText: 'x' }] }])).toThrow(
      /наоборот/,
    );
  });

  it('не массив — ошибка с формой вызова, а не молчание', () => {
    expect(() => parseEdits({ path: '/proj/a.ts' })).toThrow(/массив/);
  });

  it('элемент без path называет форму — вызов чинится за один шаг', () => {
    expect(() => parseEdits([{ oldText: 'a', newText: 'b' }])).toThrow(/edits\[0\]/);
  });

  it('запись файла целиком элементом массива: `{path, contents}` — это файл, а не замена', () => {
    // Формой `[{path, contents}]` инструмент `edit` ходил в отказ
    // «edits[0].edits[0].newText: нужна строка»: `contents` не знал `flatHunk`,
    // и запись доезжала до разбора замен без текста. Здесь сторож на весь путь.
    const [item] = normalizeWrite({
      edits: [{ path: '/proj/new.ts', contents: 'export const a = 1;\n' }],
    }) as Record<string, unknown>[];
    expect(wholeWrite(item as Record<string, unknown>)).toEqual({
      path: '/proj/new.ts',
      contents: 'export const a = 1;\n',
    });
  });

  it('combineOutcomes: единственный ответ отдаётся как есть', () => {
    const only = { ok: true, summary: 'одно' };
    expect(combineOutcomes([only])).toBe(only);
  });

  it('combineOutcomes: пустой список — не успех: ответов нет, значит и повода радоваться', () => {
    expect(combineOutcomes([]).ok).toBe(false);
  });

  it('модуль разбора не тянет за собой исполнение инструментов', () => {
    // Дешёвая, но честная проверка границы: если сюда вернётся вызов шелла или
    // хоста, файл снова станет «всем сразу».
    const source = readFileSync('src/main/ai/edit-parsing.ts', 'utf8');
    expect(source).not.toContain('child_process');
    expect(source).not.toContain('runTool(');
  });
});
