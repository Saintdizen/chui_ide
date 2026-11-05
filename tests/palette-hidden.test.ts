import { describe, expect, it } from 'vitest';
import { CommandRegistry, isHiddenFromPalette } from '../src/renderer/core/commands';

/**
 * Скрытие команды из палитры (п.3 TASKS: «невидимая — либо в палитру, либо
 * маркер `hidden` с причиной»). Проверяем обе стороны: причина убирает пункт,
 * а её отсутствие — никогда.
 */
const fill = (registry: CommandRegistry): void => {
  registry.register({ id: 'view.visible', title: 'Видимая', category: 'Вид' }, () => undefined);
  registry.register(
    { id: 'probe.hidden', title: 'Скрытая', category: 'Прочее', hidden: 'только для проб' },
    () => undefined,
  );
  registry.register({ id: 'probe.blank', title: 'Пустая причина', category: 'Прочее', hidden: '   ' }, () => undefined);
};

describe('hidden в палитре', () => {
  it('команда с причиной не попадает в список палитры', () => {
    const registry = new CommandRegistry();
    fill(registry);
    const ids = registry.paletteVisible().map((descriptor) => descriptor.id);
    expect(ids).toContain('view.visible');
    expect(ids).not.toContain('probe.hidden');
  });

  it('пустая причина — не причина: команда остаётся видимой', () => {
    const registry = new CommandRegistry();
    fill(registry);
    const ids = registry.paletteVisible().map((descriptor) => descriptor.id);
    expect(ids).toContain('probe.blank');
  });

  it('реестр остаётся полным: скрытие — про палитру, не про вызов', () => {
    const registry = new CommandRegistry();
    fill(registry);
    expect(registry.list().map((descriptor) => descriptor.id)).toContain('probe.hidden');
    expect(registry.get('probe.hidden')).toBeDefined();
  });

  it('isHiddenFromPalette различает отсутствие, пустое и осмысленное', () => {
    expect(isHiddenFromPalette({ id: 'a', title: 'A', category: 'C' })).toBe(false);
    expect(isHiddenFromPalette({ id: 'a', title: 'A', category: 'C', hidden: '' })).toBe(false);
    expect(isHiddenFromPalette({ id: 'a', title: 'A', category: 'C', hidden: 'есть причина' })).toBe(true);
  });

  it('разница list() и paletteVisible() — ровно команды с причиной', () => {
    const registry = new CommandRegistry();
    fill(registry);
    const all = new Set(registry.list().map((descriptor) => descriptor.id));
    const visible = new Set(registry.paletteVisible().map((descriptor) => descriptor.id));
    const missing = [...all].filter((id) => !visible.has(id));
    // Всё, что не видно, обязано иметь причину: нет молчаливых выпадений.
    expect(missing).toEqual(['probe.hidden']);
  });
});
