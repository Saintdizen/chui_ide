import { describe, expect, it } from 'vitest';
import { addNote, formatMemory, MAX_NOTE_CHARS, MAX_NOTES, removeNotes, sanitizeNotes } from '../src/shared/memory';

/**
 * Память проекта: добавление, удаление, формат. Правило, а не запуск — чтения с
 * диска здесь нет, поэтому проверяется без Electron.
 */

describe('sanitizeNotes', () => {
  it('читает заметки, обрезая текст и отбрасывая мусор', () => {
    const notes = sanitizeNotes([
      { text: '  важно  ', at: 5 },
      { text: '' },
      { text: 42 },
      null,
      'строка',
      { text: 'x'.repeat(MAX_NOTE_CHARS + 50) },
    ]);
    expect(notes[0]).toEqual({ text: 'важно', at: 5 });
    expect(notes).toHaveLength(2);
    expect(notes[1]!.text).toHaveLength(MAX_NOTE_CHARS);
  });

  it('не массив — пусто', () => {
    expect(sanitizeNotes('нет')).toEqual([]);
    expect(sanitizeNotes(undefined)).toEqual([]);
  });

  it('число заметок ограничено', () => {
    const many = Array.from({ length: MAX_NOTES + 10 }, (_value, index) => ({ text: `заметка ${index}`, at: 0 }));
    expect(sanitizeNotes(many)).toHaveLength(MAX_NOTES);
  });
});

describe('addNote', () => {
  it('добавляет новую заметку с временем', () => {
    const result = addNote([], 'использовать pytest', 100);
    expect(result).toEqual({ ok: true, notes: [{ text: 'использовать pytest', at: 100 }], added: true });
  });

  it('точный повтор не плодит', () => {
    const first = addNote([], 'пометка', 1);
    if (!first.ok) throw new Error('ожидалось успешное добавление');
    const second = addNote(first.notes, 'пометка', 2);
    expect(second).toEqual({ ok: true, notes: first.notes, added: false });
  });

  it('пустой текст — отказ', () => {
    expect(addNote([], '   ', 1)).toEqual({ ok: false, reason: 'empty' });
  });

  it('при переполнении честный отказ, а не потеря новой', () => {
    const full = Array.from({ length: MAX_NOTES }, (_value, index) => ({ text: `n${index}`, at: 0 }));
    expect(addNote(full, 'ещё одна', 1)).toEqual({ ok: false, reason: 'full' });
  });

  it('слишком длинную заметку обрезает', () => {
    const result = addNote([], 'x'.repeat(MAX_NOTE_CHARS + 100), 1);
    if (!result.ok) throw new Error('ожидалось успешное добавление');
    expect(result.notes[0]!.text).toHaveLength(MAX_NOTE_CHARS);
  });
});

describe('removeNotes', () => {
  it('убирает по подстроке без учёта регистра', () => {
    const notes = [
      { text: 'использовать pytest', at: 0 },
      { text: 'сборка через make', at: 0 },
    ];
    expect(removeNotes(notes, 'PYTEST')).toEqual({ notes: [{ text: 'сборка через make', at: 0 }], removed: 1 });
  });

  it('пустой запрос ничего не убирает', () => {
    const notes = [{ text: 'a', at: 0 }];
    expect(removeNotes(notes, '  ')).toEqual({ notes, removed: 0 });
  });
});

describe('formatMemory', () => {
  it('пустая память — ничего не отправляем', () => {
    expect(formatMemory([])).toBeNull();
  });

  it('заметки идут списком под заголовком', () => {
    const text = formatMemory([
      { text: 'первое', at: 0 },
      { text: 'второе', at: 0 },
    ]);
    expect(text).toContain('Память проекта');
    expect(text).toContain('- первое');
    expect(text).toContain('- второе');
  });
});
