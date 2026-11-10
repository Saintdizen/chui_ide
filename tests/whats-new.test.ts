import { describe, expect, it } from 'vitest';
import { compareVersions, parseChangelog, unseenReleases } from '../src/shared/whats-new';

/**
 * Экран «что нового» держится на трёх обещаниях, и все три проверяемы без окна:
 *   • кривая строка в CHANGELOG не ломает разбор;
 *   • «0.3.10» новее «0.3.9» — числа, а не строки;
 *   • человеку показывают то, что он ещё не видел, и ничего дважды.
 */

const SAMPLE = `
# Что нового

Вступление, которое в список не попадёт.

## 0.3.68

- Агент умеет отлаживать.
- Агент собирает проект сам.

## 0.3.9

- Старое.

## None

- Мусор без версии.
`;

describe('parseChangelog', () => {
  it('берёт выпуски со списками', () => {
    const releases = parseChangelog(SAMPLE);
    expect(releases.map((r) => r.version)).toEqual(['0.3.68', '0.3.9']);
    expect(releases[0]!.items).toEqual(['Агент умеет отлаживать.', 'Агент собирает проект сам.']);
  });

  it('вступление и мусорные заголовки не попадают', () => {
    const releases = parseChangelog(SAMPLE);
    expect(releases).toHaveLength(2);
    expect(releases.flatMap((r) => r.items)).not.toContain('Вступление, которое в список не попадёт.');
  });

  it('выпуск без списка не показываем', () => {
    expect(parseChangelog('## 1.0.0\n\nтекст без списка\n')).toEqual([]);
  });
});

describe('compareVersions', () => {
  it('сравнивает числами', () => {
    expect(compareVersions('0.3.10', '0.3.9')).toBe(1);
    expect(compareVersions('0.3.9', '0.3.10')).toBe(-1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
  });

  it('суффикс предвыпуска не ломает', () => {
    expect(compareVersions('0.3.68-beta', '0.3.68')).toBe(0);
  });
});

describe('unseenReleases', () => {
  const releases = parseChangelog(SAMPLE);

  it('первый запуск — не мешаем', () => {
    expect(unseenReleases(releases, '0.3.68', null)).toEqual([]);
  });

  it('уже видел эту версию — не мешаем', () => {
    expect(unseenReleases(releases, '0.3.68', '0.3.68')).toEqual([]);
  });

  it('видел старее — показываем только новее, свежие сверху', () => {
    const unseen = unseenReleases(releases, '0.3.68', '0.3.9');
    expect(unseen.map((r) => r.version)).toEqual(['0.3.68']);
  });

  it('будущее не обещаем', () => {
    const withFuture = parseChangelog('## 9.0.0\n\n- Ещё не вышло.\n\n## 0.3.68\n\n- Вышло.\n');
    expect(unseenReleases(withFuture, '0.3.68', '0.3.9').map((r) => r.version)).toEqual(['0.3.68']);
  });
});
