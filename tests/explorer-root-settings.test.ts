import { describe, expect, it } from 'vitest';
import type { ExplorerSettings } from '../src/shared/api';
import {
  clearRootOverride,
  describeOverride,
  hasRootOverride,
  normalizeRootOverrides,
  resolveExplorerSettings,
  rootOverrideOf,
  setRootOverride,
} from '../src/shared/explorer-settings';

/**
 * Настройки дерева на КАЖДЫЙ корень. Проверяем чистую часть: наследование общих
 * настроек, наложение отличий, запись и снятие отличий и разбор карты из файла.
 */

const BASE: ExplorerSettings = {
  icons: true,
  // Значки расширений из настроек темы: без них дерево работает на своих значках.
  badges: [],
  showHidden: true,
  foldersFirst: true,
  sort: 'name',
  indent: 12,
  rowDensity: 'normal',
  gitDecorations: true,
  folderChangeDot: true,
  recentChanges: true,
  recentWindowHours: 24,
  dimIgnored: true,
  openOnSingleClick: false,
  confirmDelete: true,
  exclude: [],
  fileNesting: false,
  nestingRules: [],
  updateImportsOnRename: true,
  groupByType: false,
  groupByPackage: false,
  byRoot: {},
};

describe('разрешение настроек корня', () => {
  it('без своих настроек корень живёт по общим', () => {
    const resolved = resolveExplorerSettings(BASE, '/p/a');
    expect(resolved.showHidden).toBe(true);
    expect(resolved.gitDecorations).toBe(true);
  });

  it('отличия корня накладываются на общие', () => {
    const base: ExplorerSettings = {
      ...BASE,
      byRoot: { '/p/a': { showHidden: false, exclude: ['*.min.js'] } },
    };
    const a = resolveExplorerSettings(base, '/p/a');
    expect(a.showHidden).toBe(false);
    expect(a.exclude).toEqual(['*.min.js']);
    // Остальные ключи — из общей настройки.
    expect(a.gitDecorations).toBe(true);

    // Другой корень не затронут.
    const b = resolveExplorerSettings(base, '/p/b');
    expect(b.showHidden).toBe(true);
    expect(b.exclude).toEqual([]);
  });

  it('списки копируются: снимок не меняется вместе с настройкой', () => {
    const base: ExplorerSettings = { ...BASE, byRoot: { '/p/a': { exclude: ['dist'] } } };
    const resolved = resolveExplorerSettings(base, '/p/a');
    resolved.exclude.push('ещё');
    expect(base.byRoot['/p/a']?.exclude).toEqual(['dist']);
  });

  it('неизвестный корень и пустой корень наследуют общее', () => {
    expect(resolveExplorerSettings(BASE, null).showHidden).toBe(true);
    expect(resolveExplorerSettings(BASE, '/нет').showHidden).toBe(true);
  });
});

describe('запись и снятие отличий', () => {
  it('отличия складываются, а не заменяются', () => {
    let overrides = setRootOverride({}, '/p/a', { showHidden: false });
    overrides = setRootOverride(overrides, '/p/a', { gitDecorations: false });
    expect(rootOverrideOf(overrides, '/p/a')).toEqual({ showHidden: false, gitDecorations: false });
  });

  it('пустая правка убирает запись корня', () => {
    const overrides = setRootOverride({ '/p/a': { showHidden: false } }, '/p/a', { showHidden: undefined });
    expect(overrides).toEqual({});
    expect(hasRootOverride(overrides, '/p/a')).toBe(false);
  });

  it('пустой список не хранится', () => {
    const overrides = setRootOverride({}, '/p/a', { exclude: [] });
    expect(overrides).toEqual({});
  });

  it('снятие настроек корня возвращает его к общим', () => {
    const overrides = clearRootOverride({ '/p/a': { icons: false } }, '/p/a');
    expect(hasRootOverride(overrides, '/p/a')).toBe(false);
  });
});

describe('разбор карты из настроек', () => {
  it('берёт известные ключи известных типов', () => {
    const parsed = normalizeRootOverrides({
      '/p/a': { showHidden: false, sort: 'time', indent: 8, exclude: ['dist', 7], мусор: true },
      '/p/b': 'строка',
      '': { icons: false },
    });
    expect(parsed).toEqual({ '/p/a': { showHidden: false, sort: 'time', indent: 8, exclude: ['dist'] } });
  });

  it('не-объект читается как пустая карта', () => {
    expect(normalizeRootOverrides(undefined)).toEqual({});
    expect(normalizeRootOverrides([1, 2])).toEqual({});
  });

  it('подпись отличий перечисляет их словами', () => {
    expect(describeOverride({ showHidden: false, exclude: ['a'] })).toBe('Показывать скрытые: выкл, исключений: 1');
    expect(describeOverride({})).toBe('');
  });
});
