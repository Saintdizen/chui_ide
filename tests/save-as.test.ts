import { describe, expect, it } from 'vitest';
import { decideSaveAs, OUTSIDE_WORKSPACE_MESSAGE } from '../src/shared/save-as';
import { normalizeRootList } from '../src/shared/workspace-roots';

/**
 * Save As: что делать с путём, выбранным в системном диалоге. Из четырёх исходов
 * писать надо только в одном — остальные три (отмена, тот же путь, путь вне области)
 * решаются без диска, и именно тут легче всего ошибиться: сохранить копию поверх
 * самого файла или записать что-то за пределами рабочей области.
 */
const roots = normalizeRootList(['/work/app']);

describe('decideSaveAs', () => {
  it('диалог отменили — сохранять нечего', () => {
    expect(decideSaveAs('/work/app/a.ts', null, roots)).toEqual({ kind: 'cancel' });
    expect(decideSaveAs('/work/app/a.ts', undefined, roots)).toEqual({ kind: 'cancel' });
    expect(decideSaveAs('/work/app/a.ts', '   ', roots)).toEqual({ kind: 'cancel' });
  });

  it('тот же путь — это обычное сохранение, а не копия', () => {
    expect(decideSaveAs('/work/app/a.ts', '/work/app/a.ts', roots)).toEqual({ kind: 'same-path' });
  });

  it('путь внутри области — пишем', () => {
    expect(decideSaveAs('/work/app/a.ts', '/work/app/src/b.ts', roots)).toEqual({
      kind: 'write',
      target: '/work/app/src/b.ts',
    });
  });

  it('вложенная папка существующего файла — тоже внутри области', () => {
    // Файл из второй папки области (multi-root) — путь всё равно её корня.
    const two = normalizeRootList(['/work/app', '/work/lib']);
    expect(decideSaveAs('/work/app/a.ts', '/work/lib/b.ts', two)).toEqual({
      kind: 'write',
      target: '/work/lib/b.ts',
    });
  });

  it('путь вне рабочей области отвергается с внятным текстом', () => {
    const decision = decideSaveAs('/work/app/a.ts', '/tmp/чужое/a.ts', roots);
    expect(decision.kind).toBe('outside');
    if (decision.kind !== 'outside') return;
    expect(decision.message).toBe(OUTSIDE_WORKSPACE_MESSAGE);
  });

  it('похожее имя не считается «внутри»: /work/app2 — не вложено в /work/app', () => {
    expect(decideSaveAs('/work/app/a.ts', '/work/app2/a.ts', roots).kind).toBe('outside');
  });

  it('путь с хвостовым разделителем выравнивается', () => {
    expect(decideSaveAs('/work/app/a.ts', '/work/app/dir/', roots)).toEqual({
      kind: 'write',
      target: '/work/app/dir',
    });
  });

  it('область не открыта — сохранять некуда', () => {
    expect(decideSaveAs('/work/app/a.ts', '/work/app/b.ts', []).kind).toBe('outside');
  });
});
