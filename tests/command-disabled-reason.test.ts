import { describe, expect, it } from 'vitest';
import { CommandRegistry } from '../src/renderer/core/commands';

/**
 * Почему команда недоступна (TASKS п.1.3: «палитра команд знает, что нельзя»).
 *
 * Серый пункт без причины читается как поломка: человек видит, что команда
 * есть, и не знает, чего не хватает. Проверяем три случая — причина есть,
 * причины нет, команда стала доступной — и что причина спрашивается каждый
 * раз заново, а не запоминается с первого взгляда.
 */
const fill = (registry: CommandRegistry, options: { enabled: boolean; reason?: () => string }): void => {
  registry.register(
    {
      id: 'git.pull',
      title: 'Влить изменения',
      category: 'Git',
      enabled: () => options.enabled,
      disabledReason: options.reason,
    },
    () => undefined,
  );
};

describe('disabledReason', () => {
  it('доступная команда причины не имеет', () => {
    const registry = new CommandRegistry();
    fill(registry, { enabled: true, reason: () => 'В проекте нет git-репозитория' });
    expect(registry.disabledReason('git.pull')).toBe('');
  });

  it('недоступная команда отдаёт причину словами', () => {
    const registry = new CommandRegistry();
    fill(registry, { enabled: false, reason: () => 'В проекте нет git-репозитория' });
    expect(registry.disabledReason('git.pull')).toBe('В проекте нет git-репозитория');
  });

  it('недоступная без причины — пустая строка, а не выдумка', () => {
    const registry = new CommandRegistry();
    fill(registry, { enabled: false });
    expect(registry.disabledReason('git.pull')).toBe('');
  });

  it('пробельная причина не считается причиной', () => {
    const registry = new CommandRegistry();
    fill(registry, { enabled: false, reason: () => '   ' });
    expect(registry.disabledReason('git.pull')).toBe('');
  });

  it('неизвестная команда — пустая строка, без падения', () => {
    const registry = new CommandRegistry();
    expect(registry.disabledReason('нет.такой')).toBe('');
  });

  it('причина перечитывается: стала доступной — пропала', () => {
    const registry = new CommandRegistry();
    let open = false;
    fill(registry, { enabled: false, reason: () => (open ? '' : 'Нет открытого проекта') });
    expect(registry.disabledReason('git.pull')).toBe('Нет открытого проекта');
    open = true;
    fill(registry, { enabled: true, reason: () => 'Нет открытого проекта' });
    expect(registry.disabledReason('git.pull')).toBe('');
    expect(registry.isEnabled('git.pull')).toBe(true);
  });
});
