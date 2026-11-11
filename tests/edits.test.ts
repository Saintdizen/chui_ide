import { describe, expect, it } from 'vitest';
import { readEditsOutcome } from '../src/main/ai/agent-edit';
import { applyTextEdits, fromOffset, toOffset, type TextEdit } from '../src/shared/edits';

/** Короткая обёртка: правка в одной строке. */
function edit(line: number, startColumn: number, endColumn: number, newText: string, oldText?: string): TextEdit {
  return {
    startLine: line,
    startColumn,
    endLine: line,
    endColumn,
    newText,
    ...(oldText !== undefined ? { oldText } : {}),
  };
}

describe('readEditsOutcome', () => {
  // Применённых файлов нет, а провал есть — это провал: до правки `ok` смотрел
  // только на `failed` и пустой `applied` считал удачей.
  it('ни одного файла — провал', () => {
    const outcome = readEditsOutcome(
      { rejected: false, result: { reports: [], failed: [{ path: 'a.ts', message: 'файл не сошёлся' }] } },
      (file) => file,
    );
    expect(outcome.ok).toBe(false);
  });

  // Отказ пользователя раньше проходил как успех: `rejected` не читался вовсе.
  it('пользователь отказался — не успех', () => {
    const outcome = readEditsOutcome({ rejected: true, result: { reports: [], failed: [] } }, (file) => file);
    expect(outcome.ok).toBe(false);
  });

  it('файл записан — успех', () => {
    const outcome = readEditsOutcome(
      { rejected: false, result: { reports: [{ path: 'a.ts', applied: 1, version: 2 }], failed: [] } },
      (file) => file,
    );
    expect(outcome.ok).toBe(true);
  });
});

describe('applyTextEdits', () => {
  it('без правок возвращает тот же текст', () => {
    expect(applyTextEdits('привет\nмир', [])).toBe('привет\nмир');
  });

  it('заменяет фрагмент в одной строке', () => {
    const text = 'const answer = 41;';
    // '41' → '42'
    expect(applyTextEdits(text, [edit(1, 16, 18, '42')])).toBe('const answer = 42;');
  });

  it('вставляет текст, не удаляя (нулевой диапазон)', () => {
    const text = 'let x=1;';
    expect(applyTextEdits(text, [edit(1, 6, 6, ' ')])).toBe('let x =1;');
  });

  it('несколько правок не «съезжают»: применяются с конца', () => {
    const text = 'aaa\nbbb\nccc';
    // Меняем строки 1 и 3 — если бы применяли сверху, смещения бы поехали.
    const edits: TextEdit[] = [edit(1, 1, 4, 'XXX'), edit(3, 1, 4, 'ZZZ')];
    expect(applyTextEdits(text, edits)).toBe('XXX\nbbb\nZZZ');
  });

  it('работает с многострочной заменой', () => {
    const text = 'one\ntwo\nthree';
    const replaceAll: TextEdit = {
      startLine: 2,
      startColumn: 1,
      endLine: 2,
      endColumn: 4,
      newText: 'TWO\nEXTRA',
    };
    expect(applyTextEdits(text, [replaceAll])).toBe('one\nTWO\nEXTRA\nthree');
  });

  it('кириллица: позиции считаются в UTF-16, замена корректна', () => {
    const text = 'имя = "значение"';
    // Заменяем «значение» (начинается с колонки 8)
    expect(applyTextEdits(text, [edit(1, 8, 16, 'другое')])).toBe('имя = "другое"');
  });

  describe('сверка oldText', () => {
    it('при совпадении применяет правку', () => {
      const text = 'const x = 1;';
      expect(applyTextEdits(text, [edit(1, 11, 12, '2', '1')])).toBe('const x = 2;');
    });

    it('при расхождении бросает и не портит текст', () => {
      const text = 'const x = 1;';
      expect(() => applyTextEdits(text, [edit(1, 11, 12, '2', '999')])).toThrow(/не совпала с текстом/);
    });
  });
});

describe('toOffset / fromOffset', () => {
  const text = 'abc\ndefg\nhi';

  it('offset начала строки', () => {
    expect(toOffset(text, 1, 1)).toBe(0);
    expect(toOffset(text, 2, 1)).toBe(4);
    expect(toOffset(text, 3, 1)).toBe(9);
  });

  it('offset с учётом колонки', () => {
    expect(toOffset(text, 2, 3)).toBe(6); // 'defg' → 4 + (3-1)
  });

  it('колонка за концом строки ограничена концом строки', () => {
    // Строка 2 — 'defg' (4 символа), колонка 100 → конец строки (offset 8).
    expect(toOffset(text, 2, 100)).toBe(8);
  });

  it('round-trip: offset → позиция → offset', () => {
    for (const offset of [0, 3, 4, 8, 9, 11]) {
      const position = fromOffset(text, offset);
      expect(toOffset(text, position.line, position.column)).toBe(offset);
    }
  });
});
