import { describe, expect, it } from 'vitest';
import { DEFAULT_GIT_SETTINGS, sanitizeGitSettings } from '../src/shared/git-settings';

/**
 * Настройки git: разбор прочитанного файла. Два поля ведут себя по-разному, и
 * разница важна — режим pull сваливается к `default` на любом мусоре (IDE не
 * навязывает флаги), а «сохранять перед коммитом» выключается ТОЛЬКО явным `false`:
 * пропавшее поле не должно тихо менять поведение.
 */
describe('DEFAULT_GIT_SETTINGS', () => {
  it('сохранять перед коммитом включено по умолчанию', () => {
    expect(DEFAULT_GIT_SETTINGS.saveBeforeCommit).toBe(true);
  });

  it('режим pull не навязывается — default', () => {
    expect(DEFAULT_GIT_SETTINGS.pullMode).toBe('default');
  });
});

describe('sanitizeGitSettings', () => {
  it('пустой вход даёт умолчания', () => {
    expect(sanitizeGitSettings({})).toEqual(DEFAULT_GIT_SETTINGS);
    expect(sanitizeGitSettings(undefined)).toEqual(DEFAULT_GIT_SETTINGS);
    expect(sanitizeGitSettings(null)).toEqual(DEFAULT_GIT_SETTINGS);
  });

  it('мусор вместо объекта не ломает разбор', () => {
    expect(sanitizeGitSettings('строка')).toEqual(DEFAULT_GIT_SETTINGS);
    expect(sanitizeGitSettings(42)).toEqual(DEFAULT_GIT_SETTINGS);
  });

  it('явное false выключает сохранение перед коммитом', () => {
    expect(sanitizeGitSettings({ saveBeforeCommit: false }).saveBeforeCommit).toBe(false);
  });

  it('отсутствие поля значит «включено», а не «выключено»', () => {
    expect(sanitizeGitSettings({ pullMode: 'rebase' }).saveBeforeCommit).toBe(true);
    expect(sanitizeGitSettings({ saveBeforeCommit: 'да' }).saveBeforeCommit).toBe(true);
    expect(sanitizeGitSettings({ saveBeforeCommit: 0 }).saveBeforeCommit).toBe(true);
  });

  it('известный режим pull проходит, чужой — default', () => {
    expect(sanitizeGitSettings({ pullMode: 'ff-only' }).pullMode).toBe('ff-only');
    expect(sanitizeGitSettings({ pullMode: 'fast-forward' }).pullMode).toBe('default');
  });

  it('поля читаются независимо: одно не портит другое', () => {
    expect(sanitizeGitSettings({ pullMode: 'rebase', saveBeforeCommit: false })).toEqual({
      pullMode: 'rebase',
      saveBeforeCommit: false,
      saveBeforeCheckout: true,
    });
  });

  it('сохранять перед переключением ветки включено по умолчанию', () => {
    expect(DEFAULT_GIT_SETTINGS.saveBeforeCheckout).toBe(true);
  });

  it('явное false выключает и сохранение перед переключением', () => {
    expect(sanitizeGitSettings({ saveBeforeCheckout: false }).saveBeforeCheckout).toBe(false);
    expect(sanitizeGitSettings({ saveBeforeCheckout: 1 }).saveBeforeCheckout).toBe(true);
  });
});
