import { describe, expect, it } from 'vitest';
import { createRecentCommands, orderByRecent } from '../src/renderer/core/recent-commands';
import { normalizeRecentCommands } from '../src/shared/recent-commands';

describe('история команд', () => {
  it('свежие сверху, повторы не плодятся', () => {
    const recent = createRecentCommands();
    recent.remember('a');
    recent.remember('b');
    recent.remember('a');
    expect(recent.ids()).toEqual(['a', 'b']);
  });

  it('порядок списка: недавние впереди, прочие — как есть', () => {
    const recent = createRecentCommands();
    recent.remember('b');
    const desc = (id: string) => ({ id, title: id, category: 'test' });
    const ordered = orderByRecent([desc('a'), desc('b'), desc('c')], recent.ids());
    expect(ordered.map((item) => item.id)).toEqual(['b', 'a', 'c']);
  });

  it('история из настроек: только строки, без повторов', () => {
    expect(normalizeRecentCommands(['a', 'a', 5, '', 'b'])).toEqual(['a', 'b']);
    expect(normalizeRecentCommands(undefined)).toEqual([]);
  });
});
