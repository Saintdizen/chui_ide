import { describe, expect, it } from 'vitest';
import { normalizePullMode, pullModeArgs, pullModeLabel, PULL_MODES } from '../src/shared/git-pull';

/**
 * Режим `pull`: подписи для интерфейса, приведение значения из настроек и флаги
 * к git. `default` — важный случай: он НЕ должен подсказывать git никаких флагов,
 * иначе IDE навязала бы своё поведение там, где человек настроил всё сам.
 */
describe('normalizePullMode', () => {
  it('известные режимы проходят как есть', () => {
    for (const mode of PULL_MODES) expect(normalizePullMode(mode)).toBe(mode);
  });

  it('мусор и чужие типы — default', () => {
    expect(normalizePullMode('fast-forward')).toBe('default');
    expect(normalizePullMode(undefined)).toBe('default');
    expect(normalizePullMode(2)).toBe('default');
  });
});

describe('pullModeArgs', () => {
  it('default не подсказывает флагов', () => {
    expect(pullModeArgs('default')).toEqual([]);
  });

  it('явные режимы дают свои флаги', () => {
    expect(pullModeArgs('merge')).toEqual(['--no-rebase']);
    expect(pullModeArgs('rebase')).toEqual(['--rebase']);
    expect(pullModeArgs('ff-only')).toEqual(['--ff-only']);
  });
});

describe('pullModeLabel', () => {
  it('у каждого режима есть подпись', () => {
    for (const mode of PULL_MODES) expect(pullModeLabel(mode).length).toBeGreaterThan(0);
  });
});
