import { describe, expect, it } from 'vitest';
import { fetchResultsSummary, type GitRootFetch } from '../src/shared/git-multiroot';

const result = (name: string, ok: boolean, message = 'ок'): GitRootFetch => ({
  root: `/p/${name}`,
  name,
  ok,
  message,
});

describe('fetchResultsSummary: итог fetch по папкам области', () => {
  it('всё удачно — ok и счёт обновлённых', () => {
    const summary = fetchResultsSummary([result('api', true), result('web', true)]);
    expect(summary.ok).toBe(true);
    expect(summary.text.split('\n')[0]).toBe('fetch: обновлено папок — 2 из 2');
  });

  it('одна папка без репозитория не губит остальные, но итог — с ошибкой', () => {
    const summary = fetchResultsSummary([result('api', true), result('tools', false, 'не репозиторий git')]);
    expect(summary.ok).toBe(false);
    expect(summary.text).toContain('обновлено папок — 1 из 2');
    expect(summary.text).toContain('tools: не репозиторий git');
    expect(summary.text).toContain('api: ок');
  });

  it('пустая область — понятный отказ, а не пустая строка', () => {
    expect(fetchResultsSummary([])).toEqual({ ok: false, text: 'В области нет ни одной папки' });
  });
});
