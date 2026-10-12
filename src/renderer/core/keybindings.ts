import type { KeybindingOverride } from '../../shared/keybindings';
import type { CommandRegistry } from './commands';

export interface Keybinding {
  /** Например `Ctrl+S`. Ctrl соответствует Cmd на macOS. */
  combo: string;
  command: string;
  args?: unknown[];
}

/** Это клавиша-модификатор, а не знак: одно нажатие Ctrl сочетанием не считается. */
export function isModifierKey(key: string): boolean {
  return key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta';
}

export function comboFromEvent(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  parts.push(key);
  return parts.join('+');
}

/**
 * Горячие клавиши в renderer. Основные сочетания перехватывает меню Electron
 * (оно шлёт команды через push-событие), здесь — только то, чего в меню нет.
 *
 * Сочетания по умолчанию приходят списком, а поверх них ложится то, что человек
 * изменил в настройках. Переопределения читаются функцией, а не значением: так
 * правка настроек меняет поведение сразу, без повторной подписки на клавиатуру.
 */
export class KeybindingService {
  constructor(
    private readonly commands: CommandRegistry,
    private readonly defaults: readonly Keybinding[],
    private readonly overrides: () => readonly KeybindingOverride[] = () => [],
  ) {}

  attach(target: Window): void {
    target.addEventListener('keydown', (event) => this.handle(event));
  }

  /**
   * Действующие сочетания: по умолчанию, с наложенными переопределениями.
   * Команда с пустым сочетанием из списка выпадает — её сочетание снято.
   */
  effective(): Keybinding[] {
    const overrides = new Map(this.overrides().map((item) => [item.command, item.combo]));
    const result: Keybinding[] = [];
    for (const binding of this.defaults) {
      const combo = overrides.has(binding.command) ? overrides.get(binding.command)! : binding.combo;
      if (combo) result.push({ ...binding, combo });
    }
    return result;
  }

  private handle(event: KeyboardEvent): void {
    const combo = comboFromEvent(event);
    const binding = this.effective().find((item) => item.combo === combo);
    if (!binding) return;
    event.preventDefault();
    void this.commands.execute(binding.command, ...(binding.args ?? []));
  }
}
