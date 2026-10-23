import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { combineOutcomes, parseEdits } from '../src/main/ai/edit-parsing';

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

  it('не массив — ошибка с формой вызова, а не молчание', () => {
    expect(() => parseEdits({ path: '/proj/a.ts' })).toThrow(/массив/);
  });

  it('элемент без path называет форму — вызов чинится за один шаг', () => {
    expect(() => parseEdits([{ oldText: 'a', newText: 'b' }])).toThrow(/edits\[0\]/);
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
