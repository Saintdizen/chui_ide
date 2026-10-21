import { describe, expect, it } from 'vitest';
import { editorSurfacePlan, pickEditorSurface, surfacesToHide } from '../src/renderer/core/editor-surface';
import type { EditorSurfaceInput } from '../src/renderer/core/editor-surface';

/** Факты «ничего не открыто, чат в панели». */
const base: EditorSurfaceInput = {
  chatInEditor: false,
  chatTabActive: false,
  activePageId: null,
  activePath: null,
  isImage: false,
  isOffice: false,
  markdownPreview: false,
};

const file: EditorSurfaceInput = { ...base, activePath: '/p/a.ts' };

describe('pickEditorSurface: старшинство', () => {
  it('пусто — обычный текст', () => {
    expect(pickEditorSurface(base)).toBe('text');
  });

  it('чат в области и его вкладка активна — чат', () => {
    expect(pickEditorSurface({ ...base, chatInEditor: true, chatTabActive: true, activePath: '/p/a.ts' })).toBe('chat');
  });

  it('чат перетянут в область, но активна другая вкладка — не чат', () => {
    expect(pickEditorSurface({ ...file, chatInEditor: true, chatTabActive: false })).toBe('text');
  });

  it('вкладка чата активна, но чат живёт в панели — не чат (иначе пустая область)', () => {
    expect(pickEditorSurface({ ...file, chatInEditor: false, chatTabActive: true })).toBe('text');
  });

  it('картинка бьёт страницу и разметку: человек выбрал именно файл', () => {
    const input = { ...file, isImage: true, activePageId: 'page-1', markdownPreview: true };
    expect(pickEditorSurface(input)).toBe('image');
  });

  it('документ Office бьёт страницу', () => {
    expect(pickEditorSurface({ ...file, isOffice: true, activePageId: 'page-1' })).toBe('doc');
  });

  it('страница бьёт текст и разметку', () => {
    expect(pickEditorSurface({ ...file, activePageId: 'page-1', markdownPreview: true })).toBe('page');
  });

  it('разметка бьёт текст у того же файла', () => {
    expect(pickEditorSurface({ ...file, markdownPreview: true })).toBe('markdown');
  });

  it('чат бьёт всё, включая картинку', () => {
    const input = { ...file, isImage: true, activePageId: 'p', chatInEditor: true, chatTabActive: true };
    expect(pickEditorSurface(input)).toBe('chat');
  });
});

describe('surfacesToHide', () => {
  it('гасим всё, кроме выбранного', () => {
    expect(surfacesToHide('text')).toEqual(['chat', 'page', 'image', 'doc', 'markdown']);
    expect(surfacesToHide('chat')).not.toContain('chat');
    expect(surfacesToHide('chat')).toHaveLength(4);
  });
});

describe('editorSurfacePlan', () => {
  it('собирает оба решения и признак обычного текста', () => {
    const plan = editorSurfacePlan({ ...file, isImage: true });
    expect(plan.shown).toBe('image');
    expect(plan.hidden).not.toContain('image');
    expect(plan.text).toBe(false);
  });

  it('для текста hidden содержит все экраны', () => {
    const plan = editorSurfacePlan(file);
    expect(plan.shown).toBe('text');
    expect(plan.text).toBe(true);
    expect(plan.hidden).toContain('chat');
  });
});
