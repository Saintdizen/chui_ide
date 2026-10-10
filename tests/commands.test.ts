import { describe, expect, it } from 'vitest';
import { CommandRegistry } from '../src/renderer/core/commands';

const base = { title: 'Команда', category: 'Вид' };

describe('CommandRegistry.isEnabled', () => {
  it('без `enabled` команда доступна всегда', () => {
    const commands = new CommandRegistry();
    commands.register({ id: 'x', ...base }, () => undefined);
    expect(commands.isEnabled('x')).toBe(true);
  });

  it('учитывает `enabled`', () => {
    const commands = new CommandRegistry();
    commands.register({ id: 'x', ...base, enabled: () => false }, () => undefined);
    expect(commands.isEnabled('x')).toBe(false);
  });

  it('`enabled` считается на каждый вызов — состояние может меняться', () => {
    let ready = false;
    const commands = new CommandRegistry();
    commands.register({ id: 'x', ...base, enabled: () => ready }, () => undefined);
    expect(commands.isEnabled('x')).toBe(false);
    ready = true;
    expect(commands.isEnabled('x')).toBe(true);
  });

  it('неизвестная команда считается доступной', () => {
    const commands = new CommandRegistry();
    expect(commands.isEnabled('нет-такой')).toBe(true);
  });

  // Недоступность — подсказка палитре (погасить пункт), а не запрет запуска:
  // ту же команду зовут горячие клавиши и ассистент, и решать за них нечего.
  it('`execute` не блокируется пометкой `enabled`', async () => {
    let ran = 0;
    const commands = new CommandRegistry();
    commands.register({ id: 'x', ...base, enabled: () => false }, () => {
      ran += 1;
    });
    await commands.execute('x');
    expect(ran).toBe(1);
  });
});
