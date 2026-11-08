import { describe, expect, it } from 'vitest';
import { noteOf, notesInFolder, sanitizeNotes, setFileNote, setProjectNote } from '../src/shared/notes';

/**
 * Заметки человека: к файлам и к проекту. Главное — пережить перезапуск
 * (значит, разбор из файла сессии не должен терять и не должен воскрешать
 * чужое) и не превратить дерево в простыню (значок у папки — счётчик).
 */
const root = '/p';

describe('заметки к файлам', () => {
  it('ставится и читается', () => {
    const notes = setFileNote({ project: null, files: [] }, '/p/src/a.ts', 'тут гонка', undefined, root);
    expect(noteOf(notes, '/p/src/a.ts', root)?.text).toBe('тут гонка');
    expect(noteOf(notes, '/p/src/b.ts', root)).toBeNull();
  });

  it('пустой текст снимает заметку', () => {
    const once = setFileNote({ project: null, files: [] }, '/p/a.ts', 'х');
    expect(setFileNote(once, '/p/a.ts', '   ').files).toEqual([]);
  });

  it('заметки отсортированы по пути: порядок не зависит от порядка ввода', () => {
    let notes = { project: null, files: [] as never[] };
    notes = setFileNote(notes as never, '/p/b.ts', 'b', undefined, root) as never;
    notes = setFileNote(notes as never, '/p/a.ts', 'a', undefined, root) as never;
    // Пути хранятся от корня: заметка переживает перенос папки проекта.
    expect((notes as never as { files: { path: string }[] }).files.map((f) => f.path)).toEqual([
      'a.ts',
      'b.ts',
    ]);
  });

  it('проект: один текст на все', () => {
    const notes = setProjectNote({ project: null, files: [] }, 'запускать через make');
    expect(notes.project).toBe('запускать через make');
    expect(setProjectNote(notes, '   ').project).toBeNull();
  });
});

describe('sanitizeNotes', () => {
  it('чужие пути выбрасываются: сессия одного проекта — не другого', () => {
    const raw = {
      files: [
        { path: '/p/src/a.ts', text: 'тут' },
        { path: '/other/x.ts', text: 'чужое' },
      ],
    };
    expect(sanitizeNotes(raw, root).files.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('битые записи и пустые тексты не воскресают', () => {
    const raw = { files: [{ path: '/p/a.ts', text: '  ' }, null, 'строка', { text: 'без пути' }] };
    expect(sanitizeNotes(raw, root).files).toEqual([]);
  });

  it('не объект — пусто, без падения', () => {
    expect(sanitizeNotes(undefined, root)).toEqual({ project: null, files: [] });
  });
});

describe('notesInFolder', () => {
  it('считает заметки внутри папки', () => {
    let notes = { project: null, files: [] as never[] };
    for (const path of ['/p/src/a.ts', '/p/src/b.ts', '/p/docs/c.md']) {
      notes = setFileNote(notes as never, path, 'x', undefined, root) as never;
    }
    // Папки — от корня, как и пути заметок.
    expect(notesInFolder(notes as never, 'src')).toBe(2);
    expect(notesInFolder(notes as never, '')).toBe(3);
  });
});
