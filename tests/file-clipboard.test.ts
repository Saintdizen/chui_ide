import { describe, expect, it } from 'vitest';
import { pasteNotice, planPaste, type FileClip } from '../src/renderer/core/file-clipboard';

/**
 * Буфер проводника: вставить можно не всегда, и каждый запрет — правило, а не
 * случайность. Что именно человеку нельзя: положить папку в себя, скопировать
 * поверх существующего, «перенести» туда, где вещь уже лежит.
 */

const clip = (mode: 'copy' | 'move', ...paths: string[]): FileClip => ({ mode, paths });
const none = (): boolean => false;

describe('planPaste', () => {
  it('копирует в другую папку', () => {
    const plan = planPaste(clip('copy', '/p/src/a.ts'), '/p/dst', none);
    expect(plan.targets).toEqual(['/p/dst/a.ts']);
    expect(plan.sources).toEqual(['/p/src/a.ts']);
  });

  it('папка не уезжает в свой же подкаталог', () => {
    const plan = planPaste(clip('move', '/p/dir'), '/p/dir/inner', none);
    expect(plan.sources).toEqual([]);
    expect(plan.skipped).toBe(1);
  });

  it('перенос в ту же папку — промах, не действие', () => {
    const plan = planPaste(clip('move', '/p/dir/a.ts'), '/p/dir', none);
    expect(plan.skipped).toBe(1);
  });

  it('существующее не перезаписывается', () => {
    const plan = planPaste(clip('copy', '/p/src/a.ts'), '/p/dst', (path) => path === '/p/dst/a.ts');
    expect(plan.conflicts).toEqual(['a.ts']);
    expect(plan.sources).toEqual([]);
  });

  it('одно препятствие не отменяет остальные', () => {
    const plan = planPaste(clip('copy', '/p/src/a.ts', '/p/src/b.ts'), '/p/dst', (path) => path === '/p/dst/a.ts');
    expect(plan.sources).toEqual(['/p/src/b.ts']);
    expect(plan.conflicts).toEqual(['a.ts']);
  });
});

describe('pasteNotice', () => {
  it('считает вслух', () => {
    const plan = planPaste(clip('copy', '/p/src/a.ts', '/p/src/b.ts'), '/p/dst', (path) => path === '/p/dst/a.ts');
    expect(pasteNotice(plan, clip('copy'))).toBe('скопировано: 1 · уже есть: 1');
  });

  it('перенос называет себя переносом', () => {
    const plan = planPaste(clip('move', '/p/src/a.ts'), '/p/dst', none);
    expect(pasteNotice(plan, clip('move'))).toBe('перенесено: 1');
  });

  it('нечего сказать — говорит и это', () => {
    expect(pasteNotice({ sources: [], targets: [], skipped: 0, conflicts: [] }, clip('copy'))).toBe('Вставлять нечего');
  });
});
