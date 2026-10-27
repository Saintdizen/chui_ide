import { describe, expect, it } from 'vitest';
import { editorContextMenuPlan, type EditorMenuDeps } from '../src/renderer/core/editor-menu';
import type { EditorContextInfo } from '../src/renderer/editor/host/editor-host';

function info(over: Partial<EditorContextInfo> = {}): EditorContextInfo {
  return {
    path: '/p/a.ts',
    line: 7,
    column: 3,
    hasSelection: false,
    selectedText: '',
    canUndo: true,
    canRedo: true,
    ...over,
  };
}

function deps(over: Partial<EditorMenuDeps> = {}) {
  const calls: string[] = [];
  const base: EditorMenuDeps = {
    hasAction: () => false,
    runAction: (id) => calls.push(`action:${id}`),
    cut: () => calls.push('cut'),
    copy: () => calls.push('copy'),
    paste: () => calls.push('paste'),
    spellingAtCursor: () => false,
    addToDictionary: () => calls.push('addToDictionary'),
    ignoreSpelling: () => calls.push('ignoreSpelling'),
    isBookmarked: () => false,
    toggleBookmark: (path, line) => calls.push(`toggle:${path}:${line}`),
    openBookmarks: () => calls.push('openBookmarks'),
    refactorMenu: (path) => calls.push(`refactorMenu:${path}`),
    refactor: (path, action) => calls.push(`refactor:${path}:${action}`),
    codeActions: (path, position) => calls.push(`codeActions:${path}:${position.line}:${position.column}`),
    ...over,
  };
  return { deps: base, calls };
}

const labels = (items: ReturnType<typeof editorContextMenuPlan>) =>
  items.map((item) => ('label' in item ? item.label : '—'));

describe('editorContextMenuPlan', () => {
  it('без выделения не предлагает вырезать и копировать, но вставку даёт', () => {
    const items = editorContextMenuPlan(info(), deps().deps);
    expect(labels(items)).not.toContain('Вырезать');
    expect(labels(items)).not.toContain('Копировать');
    expect(labels(items)).toContain('Вставить');
  });

  it('без языкового сервера прячет переходы, рефакторинги и быстрые исправления', () => {
    const items = editorContextMenuPlan(info(), deps().deps);
    expect(labels(items)).not.toContain('Перейти к определению');
    expect(labels(items)).not.toContain('Рефакторинг…');
    expect(labels(items)).not.toContain('Быстрые исправления…');
  });

  it('с сервером и выделением добавляет извлечение и быстрые исправления', () => {
    const withLsp = deps({ hasAction: () => true }).deps;
    const items = editorContextMenuPlan(info({ hasSelection: true }), withLsp);
    expect(labels(items)).toContain('Перейти к определению');
    expect(labels(items)).toContain('Рефакторинг…');
    expect(labels(items)).toContain('Извлечь…');
    expect(labels(items)).toContain('Развернуть (inline)…');
    expect(labels(items)).toContain('Быстрые исправления…');
  });

  it('без выделения не предлагает извлечение, но оставляет остальные рефакторинги', () => {
    const withLsp = deps({ hasAction: () => true }).deps;
    const items = editorContextMenuPlan(info(), withLsp);
    expect(labels(items)).not.toContain('Извлечь…');
    expect(labels(items)).toContain('Развернуть (inline)…');
  });

  it('без открытого файла не предлагает ни закладок, ни рефакторингов', () => {
    const withLsp = deps({ hasAction: () => true }).deps;
    const items = editorContextMenuPlan(info({ path: null }), withLsp);
    expect(labels(items)).not.toContain('Поставить закладку');
    expect(labels(items)).not.toContain('Закладки…');
    expect(labels(items)).not.toContain('Рефакторинг…');
  });

  it('название пункта закладки зависит от того, стоит ли она', () => {
    const { deps: d, calls } = deps({ isBookmarked: () => true });
    const items = editorContextMenuPlan(info({ line: 12 }), d);
    expect(labels(items)).toContain('Убрать закладку');
    const bookmark = items.find((item) => 'label' in item && item.label === 'Убрать закладку');
    if (bookmark && 'onSelect' in bookmark) bookmark.onSelect?.();
    expect(calls).toEqual(['toggle:/p/a.ts:12']);
  });

  it('быстрые исправления зовутся с местом клика', () => {
    const { deps: d, calls } = deps({ hasAction: () => true });
    const items = editorContextMenuPlan(info({ line: 4, column: 9 }), d);
    const quickFix = items.find((item) => 'label' in item && item.label === 'Быстрые исправления…');
    if (quickFix && 'onSelect' in quickFix) quickFix.onSelect?.();
    expect(calls).toEqual(['codeActions:/p/a.ts:4:9']);
  });

  it('пункты словаря появляются только при ошибке под курсором', () => {
    expect(labels(editorContextMenuPlan(info(), deps().deps))).not.toContain('Добавить в словарь');
    const items = editorContextMenuPlan(info(), deps({ spellingAtCursor: () => true }).deps);
    expect(labels(items)).toContain('Добавить в словарь');
    expect(labels(items)).toContain('Пропустить слово');
  });
});
