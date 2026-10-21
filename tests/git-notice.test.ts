import { describe, expect, it } from 'vitest';
import { rebaseNotice } from '../src/renderer/core/git-notice';

describe('rebaseNotice', () => {
  it('конфликт — прежде всего: пока он есть, остальное неважно', () => {
    const notice = rebaseNotice({ ok: false, inProgress: true, conflict: true, message: 'stop' });
    expect(notice.kind).toBe('error');
    expect(notice.message).toContain('конфликт');
  });

  it('идёт дальше — это не ошибка, а подсказка, что делать', () => {
    const notice = rebaseNotice({ ok: true, inProgress: true, conflict: false, message: '' });
    expect(notice.kind).toBe('info');
    expect(notice.message).toContain('продолжите');
  });

  it('конфликт важнее «идёт»: оба флага сразу — говорим про конфликт', () => {
    const notice = rebaseNotice({ ok: true, inProgress: true, conflict: true, message: '' });
    expect(notice.message).toContain('конфликт');
  });

  it('завершён', () => {
    expect(rebaseNotice({ ok: true, inProgress: false, conflict: false, message: '' })).toEqual({
      message: 'Rebase завершён',
      kind: 'info',
    });
  });

  it('провал — текст git доходит до человека', () => {
    const notice = rebaseNotice({ ok: false, inProgress: false, conflict: false, message: 'fatal: not a git repo' });
    expect(notice).toEqual({ message: 'fatal: not a git repo', kind: 'error' });
  });
});
