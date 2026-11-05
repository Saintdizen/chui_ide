import { describe, expect, it } from 'vitest';
import { emptyReasonFor, emptyState } from '../src/renderer/core/empty-state';

const base = {
  isLoading: false,
  failed: false,
  hasFilter: false,
  total: 0,
  shown: 0,
  excluded: 0,
  isRoot: false,
};

describe('emptyReasonFor: какой из пяти случаев', () => {
  it('пока читаем — не говорим ничего', () => {
    expect(emptyReasonFor({ ...base, isLoading: true })).toBeNull();
  });

  it('пустая папка и пустой проект — разные причины', () => {
    expect(emptyReasonFor(base)).toBe('folder-empty');
    expect(emptyReasonFor({ ...base, isRoot: true })).toBe('project-empty');
  });

  it('пропал корень — это root-gone, а не пустая папка', () => {
    // Иначе человек пойдёт создавать файл в папку, которой нет.
    expect(emptyReasonFor({ ...base, failed: true, isRoot: true })).toBe('root-gone');
  });

  it('не прочиталась вложенная папка — молчим: у неё своя строка «не удалось»', () => {
    expect(emptyReasonFor({ ...base, failed: true })).toBeNull();
  });

  it('исключённое важнее пустоты', () => {
    // Папка полна, просто спрятана: сказать «пуста» — соврать.
    expect(emptyReasonFor({ ...base, total: 5, shown: 0, excluded: 5 })).toBe('excluded-only');
  });

  it('фильтр без совпадений — свой случай, даже если файлы есть', () => {
    expect(emptyReasonFor({ ...base, hasFilter: true, total: 10, shown: 0 })).toBe('filter-empty');
  });

  it('фильтр с совпадениями — сказать нечего', () => {
    expect(emptyReasonFor({ ...base, hasFilter: true, total: 10, shown: 3 })).toBeNull();
  });

  it('файлы есть и показаны — пустого места нет', () => {
    expect(emptyReasonFor({ ...base, total: 3, shown: 3 })).toBeNull();
  });
});

describe('emptyState: разные беды — разные слова и кнопки', () => {
  it('у каждой причины свой заголовок: одинаковых нет', () => {
    const reasons = ['project-empty', 'folder-empty', 'root-gone', 'filter-empty', 'excluded-only'] as const;
    const titles = reasons.map((reason) => emptyState(reason).title);
    expect(new Set(titles).size).toBe(reasons.length);
  });

  it('у каждой причины есть действие — пустого места без выхода не бывает', () => {
    const reasons = ['project-empty', 'folder-empty', 'root-gone', 'filter-empty', 'excluded-only'] as const;
    for (const reason of reasons) expect(emptyState(reason).action).not.toBeNull();
  });

  it('у каждой причины свой текст подсказки', () => {
    const reasons = ['project-empty', 'folder-empty', 'root-gone', 'filter-empty', 'excluded-only'] as const;
    const hints = reasons.map((reason) => emptyState(reason).hint);
    expect(new Set(hints).size).toBe(reasons.length);
  });

  it('excluded-only называет маски, которые спрятали папку', () => {
    const state = emptyState('excluded-only', ['dist/', '*.min.js']);
    expect(state.hint).toContain('dist/');
    expect(state.hint).toContain('*.min.js');
  });

  it('без масок excluded-only всё равно объясняет, что папка не пуста', () => {
    expect(emptyState('excluded-only').hint).toContain('не пустая');
  });
});
