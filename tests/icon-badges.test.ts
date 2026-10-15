import { describe, expect, it } from 'vitest';
import { badgeFor, badgeTitle, parseBadgeTheme, sanitizeBadgeRules } from '../src/shared/icon-badges';

/**
 * Значки дерева от сторонних наборов. Проверяем чистую часть: разбор правил,
 * выбор значка по маске и разбор файла набора (его приносит человек или чужая
 * программа, поэтому структура проверяется).
 */

const RULES = sanitizeBadgeRules([
  { pattern: '*.generated.*', badge: 'gen', color: 'orange', title: 'Сгенерировано' },
  { pattern: 'src/api/**', color: 'blue' },
  { pattern: 'TODO.md', badge: 'todo', color: 'red' },
]);

describe('выбор значка по маске', () => {
  it('маска по имени файла', () => {
    expect(badgeFor('/p/src/models/user.generated.ts', 'src/models/user.generated.ts', RULES)?.badge).toBe('gen');
  });

  it('маска по пути от корня', () => {
    const found = badgeFor('/p/src/api/client.ts', 'src/api/client.ts', RULES);
    expect(found?.color).toBe('blue');
    expect(found?.badge).toBeUndefined();
  });

  it('первое подошедшее правило важнее следующих: порядок задаёт человек', () => {
    const rules = sanitizeBadgeRules([
      { pattern: 'src/**', color: 'green' },
      { pattern: 'src/api/**', color: 'blue' },
    ]);
    expect(badgeFor('/p/src/api/client.ts', 'src/api/client.ts', rules)?.color).toBe('green');
  });

  it('нет правил — нет значка', () => {
    expect(badgeFor('/p/a.ts', 'a.ts', [])).toBeNull();
    expect(badgeFor('/p/a.ts', 'a.ts', RULES)).toBeNull();
  });

  it('регистр маски не важен', () => {
    expect(badgeFor('/p/TODO.md', 'TODO.md', RULES)?.color).toBe('red');
    expect(badgeFor('/p/todo.md', 'todo.md', RULES)?.color).toBe('red');
  });
});

describe('разбор правил', () => {
  it('чужие значения приводятся к известным', () => {
    const rules = sanitizeBadgeRules([
      { pattern: ' a ', badge: 'длиннаяподпись', color: 'неон' },
      { pattern: '' },
      'строка',
      { badge: 'нет маски' },
    ]);
    expect(rules).toEqual([{ pattern: 'a', badge: 'дли', color: 'gray' }]);
  });

  it('подпись обрезается по знакам, а не по байтам', () => {
    const [rule] = sanitizeBadgeRules([{ pattern: 'x', badge: '⚙⚙⚙⚙', color: 'gray' }]);
    expect([...(rule?.badge ?? '')]).toHaveLength(3);
  });

  it('без подписи правило остаётся: это «пометить цветом»', () => {
    expect(sanitizeBadgeRules([{ pattern: 'x' }])).toEqual([{ pattern: 'x', color: 'gray' }]);
  });
});

describe('разбор файла набора', () => {
  it('массив правил', () => {
    // Подпись короче трёх знаков берётся как есть; длинную обрезает разбор правил.
    const parsed = parseBadgeTheme('[{"pattern":"*.mock.*","badge":"mk","color":"purple"}]');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.rules[0]?.badge).toBe('mk');
  });

  it('объект с полем badges — как тема значков', () => {
    const parsed = parseBadgeTheme('{"badges":[{"pattern":"generated/**","color":"orange"}]}');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.rules).toHaveLength(1);
  });

  it('битый JSON и чужая форма объясняются словами', () => {
    const broken = parseBadgeTheme('{');
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error).toContain('JSON');

    const wrong = parseBadgeTheme('{"rules":[]}');
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error).toContain('badges');
  });

  it('набор без масок не принимается: рисовать нечего', () => {
    const empty = parseBadgeTheme('[{"color":"red"}]');
    expect(empty.ok).toBe(false);
  });
});

describe('подсказка значка', () => {
  it('своя подпись важнее образца маски', () => {
    expect(badgeTitle({ pattern: 'x', color: 'red', title: 'Только через клиент' })).toBe('Только через клиент');
    expect(badgeTitle({ pattern: 'src/**', color: 'blue' })).toContain('src/**');
  });
});
