import { describe, expect, it } from 'vitest';
import {
  addNote,
  formatMemory,
  MAX_NOTE_CHARS,
  MAX_NOTES,
  parseMemory,
  removeNotes,
  serializeMemory,
} from '../src/shared/memory';

/**
 * Память ассистента: разбор и сборка .md-файла, добавление, удаление, формат
 * блока для промпта. Правило, а не запуск — диск не трогаем, поэтому проверяется
 * без Electron.
 */

describe('parseMemory', () => {
  it('берёт строки-заметки и пропускает заголовок и пояснение', () => {
    const text = [
      '# Память проекта',
      '',
      'Заметки ассистента. Строка с дефисом — заметка.',
      '',
      '- использовать pytest',
      '- сборка через make',
      '',
    ].join('\n');
    expect(parseMemory(text)).toEqual([{ text: 'использовать pytest' }, { text: 'сборка через make' }]);
  });

  it('файл без заметок — пусто', () => {
    expect(parseMemory('')).toEqual([]);
    expect(parseMemory('# Только заголовок\n')).toEqual([]);
    // Дефис без пробела — не заметка (это может быть разделитель).
    expect(parseMemory('-нет пробела\n')).toEqual([]);
  });

  it('длинную заметку подрезает, число ограничивает', () => {
    const many = Array.from({ length: MAX_NOTES + 5 }, (_value, index) => `- заметка ${index}`).join('\n');
    expect(parseMemory(many)).toHaveLength(MAX_NOTES);

    const long = parseMemory(`- ${'x'.repeat(MAX_NOTE_CHARS + 100)}`);
    expect(long[0]!.text).toHaveLength(MAX_NOTE_CHARS);
  });
});

describe('serializeMemory', () => {
  it('собирает файл с шапкой и заметками, разбор читает его обратно', () => {
    const notes = [{ text: 'первое' }, { text: 'второе' }];
    const text = serializeMemory(notes, 'Память проекта');
    expect(text).toContain('# Память проекта');
    expect(text).toContain('- первое');
    // Главное — обратимость: записали и прочли то же самое.
    expect(parseMemory(text)).toEqual(notes);
  });

  it('пустая память — только шапка, разбор даёт пусто', () => {
    const text = serializeMemory([], 'Память проекта');
    expect(text).toContain('# Память проекта');
    expect(parseMemory(text)).toEqual([]);
  });
});

describe('addNote', () => {
  it('добавляет новую заметку', () => {
    expect(addNote([], 'использовать pytest')).toEqual({
      ok: true,
      notes: [{ text: 'использовать pytest' }],
      added: true,
    });
  });

  it('точный повтор не плодит', () => {
    const first = addNote([], 'пометка');
    if (!first.ok) throw new Error('ожидалось успешное добавление');
    expect(addNote(first.notes, 'пометка')).toEqual({ ok: true, notes: first.notes, added: false });
  });

  it('пустой текст — отказ', () => {
    expect(addNote([], '   ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('при переполнении честный отказ, а не потеря новой', () => {
    const full = Array.from({ length: MAX_NOTES }, (_value, index) => ({ text: `n${index}` }));
    expect(addNote(full, 'ещё одна')).toEqual({ ok: false, reason: 'full' });
  });

  it('слишком длинную заметку обрезает', () => {
    const result = addNote([], 'x'.repeat(MAX_NOTE_CHARS + 100));
    if (!result.ok) throw new Error('ожидалось успешное добавление');
    expect(result.notes[0]!.text).toHaveLength(MAX_NOTE_CHARS);
  });
});

describe('removeNotes', () => {
  it('убирает по подстроке без учёта регистра', () => {
    const notes = [{ text: 'использовать pytest' }, { text: 'сборка через make' }];
    expect(removeNotes(notes, 'PYTEST')).toEqual({ notes: [{ text: 'сборка через make' }], removed: 1 });
  });

  it('пустой запрос ничего не убирает', () => {
    const notes = [{ text: 'a' }];
    expect(removeNotes(notes, '  ')).toEqual({ notes, removed: 0 });
  });
});

describe('formatMemory', () => {
  it('пустая память — ничего не отправляем', () => {
    expect(formatMemory([])).toBeNull();
    expect(formatMemory([], 'global')).toBeNull();
  });

  it('заметки идут списком под заголовком области', () => {
    const text = formatMemory([{ text: 'первое' }, { text: 'второе' }]);
    expect(text).toContain('Память проекта');
    expect(text).toContain('- первое');
    expect(text).toContain('- второе');
  });

  it('глобальная область подписана иначе, чем память проекта', () => {
    const text = formatMemory([{ text: 'язык ответов — русский' }], 'global');
    expect(text).toContain('общая');
    expect(text).not.toContain('Память проекта');
  });
});
