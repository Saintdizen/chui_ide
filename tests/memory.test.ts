import { describe, expect, it } from 'vitest';
import {
  addNote,
  formatMemory,
  MAX_NOTE_CHARS,
  MAX_NOTES,
  MEMORY_PROMPT_CHARS,
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

  it('при переполнении вытесняет самую давнюю, а не теряет новую', () => {
    const full = Array.from({ length: MAX_NOTES }, (_value, index) => ({ text: `n${index}` }));
    const result = addNote(full, 'ещё одна');
    if (!result.ok) throw new Error('ожидалось успешное добавление');
    expect(result.dropped).toBe('n0');
    expect(result.notes).toHaveLength(MAX_NOTES);
    expect(result.notes[0]).toEqual({ text: 'n1' });
    expect(result.notes[MAX_NOTES - 1]).toEqual({ text: 'ещё одна' });
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

  // Память едет в каждом шаге прогона, то есть дороже схем инструментов: при
  // потолке в 40 заметок по 320 символов она весила бы тысячи токенов на шаг.
  // В промпт идёт только видимая часть — и с пометкой, что она не вся: иначе
  // агент записал бы уже записанное, приняв молчание за чистый лист.
  it('в промпт идёт бюджет, а не вся память, и скрытое названо числом', () => {
    const many = Array.from({ length: MAX_NOTES }, (_, at) => ({ text: `заметка ${at} `.padEnd(200, 'x') }));
    const text = formatMemory(many)!;
    const body = text.split('\n').filter((line) => line.startsWith('- '));

    expect(text.length).toBeLessThan(MEMORY_PROMPT_CHARS + 400);
    expect(body.length).toBeLessThan(many.length);
    expect(text).toContain(`ещё ${many.length - body.length}`);
  });

  it('скрываются давние заметки, а свежие остаются', () => {
    const many = Array.from({ length: 30 }, (_, at) => ({ text: `заметка ${at} `.padEnd(200, 'x') }));
    const text = formatMemory(many)!;

    expect(text).toContain('- заметка 29');
    expect(text).not.toContain('- заметка 0 ');
  });
});
