import { describe, expect, it } from 'vitest';
import { countOccurrences, parsePatchFiles, resolvePatches } from '../src/shared/patch';
import { applyTextEdits } from '../src/shared/edits';

/**
 * Правки по якорю: позиции не называются, их считает документ.
 *
 * Здесь важен не только «счастливый путь», но и два отказа: якоря нет вовсе и
 * якорь не один. Оба должны быть сказаны словами — от этого зависит, догадается
 * ли модель взять фрагмент шире или перечитает файл.
 */

const FILE = [
  'def load(path):',
  '    text = read(path)',
  '    if not text:',
  "        raise ValueError('пусто')",
  '    return text',
  '',
].join('\n');

describe('resolvePatches: обычный случай', () => {
  it('находит якорь и считает позиции сам', () => {
    const result = resolvePatches(FILE, [{ oldText: 'read(path)', newText: 'read_file(path)' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [edit] = result.edits;
    // `read(path)` стоит на второй строке с 12-го символа (1-based); конец —
    // исключающий, как и везде в контракте правок (стиль LSP).
    expect(edit).toMatchObject({ startLine: 2, startColumn: 12, endLine: 2, endColumn: 22 });
    // Якорь кладётся и в правку: документ сверит его ещё раз перед применением.
    expect(edit?.oldText).toBe('read(path)');
    expect(applyTextEdits(FILE, result.edits)).toContain('text = read_file(path)');
  });

  it('кириллица не сбивает столбцы', () => {
    // Ровно та причина, ради которой якорь и заведён: столбцы для не-ASCII
    // модель считает на глаз, а поиск — точно.
    const result = resolvePatches(FILE, [
      { oldText: "raise ValueError('пусто')", newText: "raise ValueError('пусто!')" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(applyTextEdits(FILE, result.edits)).toContain("raise ValueError('пусто!')");
  });

  it('многострочный якорь: правка в середине блока', () => {
    const result = resolvePatches(FILE, [{ oldText: '    if not text:\n', newText: '' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(applyTextEdits(FILE, result.edits)).not.toContain('if not text:');
  });

  it('несколько патчей по порядку применяются оба', () => {
    const result = resolvePatches(FILE, [
      { oldText: 'load(path)', newText: 'load_source(path)' },
      { oldText: 'return text', newText: 'return text.strip()' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const applied = applyTextEdits(FILE, result.edits);
    expect(applied).toContain('def load_source(path):');
    expect(applied).toContain('return text.strip()');
  });

  it('каждый якорь ищется в исходном тексте, а не в результате соседнего патча', () => {
    // Порядок в наборе не важен: это набор мест одного документа, а не сценарий.
    // Якорь, которого в исходном тексте нет, честно отвергается — иначе пришлось
    // бы угадывать, что он появился от предыдущей правки.
    const result = resolvePatches('const a = 1;', [
      { oldText: 'const a = 1;', newText: 'const a = 100;' },
      { oldText: '= 100;', newText: '= 200;' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('не найден');
  });

  it('набор из независимых мест применяется целиком', () => {
    const text = 'one = 1\ntwo = 2\n';
    const result = resolvePatches(text, [
      { oldText: 'one = 1', newText: 'one = 10' },
      { oldText: 'two = 2', newText: 'two = 20' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(applyTextEdits(text, result.edits)).toBe('one = 10\ntwo = 20\n');
  });

  it('пустая замена удаляет найденное', () => {
    const result = resolvePatches(FILE, [{ oldText: '    if not text:\n', newText: '' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(applyTextEdits(FILE, result.edits).split('\n')).toHaveLength(5);
  });
});

describe('resolvePatches: отказы', () => {
  it('якоря нет — говорим прямо и советуем перечитать файл', () => {
    const result = resolvePatches(FILE, [{ oldText: 'нет такого текста', newText: 'x' }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('не найден');
    expect(result.message).toContain('read_file');
  });

  it('якорь встречается дважды — просим взять шире, а не угадываем', () => {
    const text = 'x = 1\ny = 1\n';
    const result = resolvePatches(text, [{ oldText: '= 1', newText: '= 2' }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('2 раз');
    expect(result.message).toContain('шире');
  });

  it('пустой якорь отвергается: нечего искать', () => {
    const result = resolvePatches(FILE, [{ oldText: '', newText: 'x' }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('пустой якорь');
  });

  it('номер правки назван, когда их несколько', () => {
    const result = resolvePatches(FILE, [
      { oldText: 'def load(path):', newText: 'def load(p):' },
      { oldText: 'не найдётся', newText: 'x' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('правка 2');
  });

  it('пустой список правок — ошибка, а не «применено 0»', () => {
    expect(resolvePatches(FILE, []).ok).toBe(false);
  });

  it('ничего не применяется, если хотя бы один якорь не сошёлся', () => {
    // Отказ до применения: правки возвращаются только целиком.
    const result = resolvePatches(FILE, [
      { oldText: 'load(path)', newText: 'load_source(path)' },
      { oldText: 'нет такого', newText: 'x' },
    ]);
    expect(result.ok).toBe(false);
  });
});

describe('countOccurrences', () => {
  it('считает вхождения без перекрытий', () => {
    expect(countOccurrences('aaaa', 'aa')).toBe(2);
    expect(countOccurrences('abcabcabc', 'abc')).toBe(3);
    expect(countOccurrences('abc', 'z')).toBe(0);
    expect(countOccurrences('abc', '')).toBe(0);
  });
});

describe('parsePatchFiles', () => {
  it('принимает верные данные', () => {
    const files = parsePatchFiles([{ path: '/p/a.ts', patches: [{ oldText: 'a', newText: 'b' }] }]);
    expect(files).toEqual([{ path: '/p/a.ts', patches: [{ oldText: 'a', newText: 'b' }] }]);
  });

  it('отвергает битую структуру, называя место', () => {
    expect(() => parsePatchFiles('нет')).toThrow(/массивом/);
    expect(() => parsePatchFiles([])).toThrow(/ни одной правки/);
    expect(() => parsePatchFiles([{ patches: [] }])).toThrow(/не задан path/);
    expect(() => parsePatchFiles([{ path: '/p', patches: [] }])).toThrow(/непустой массив/);
    expect(() => parsePatchFiles([{ path: '/p', patches: [{ oldText: 'a' }] }])).toThrow(/newText/);
    expect(() => parsePatchFiles([{ path: '/p', patches: [{ newText: 'b' }] }])).toThrow(/oldText/);
  });
});
