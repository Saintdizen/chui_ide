import type { CommandRegistry } from './commands';

export interface Keybinding {
  /** Например `Ctrl+S`. Ctrl соответствует Cmd на macOS. */
  combo: string;
  command: string;
  args?: unknown[];
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
 */
export class KeybindingService {
  constructor(
    private readonly commands: CommandRegistry,
    private readonly bindings: readonly Keybinding[],
  ) {}

  attach(target: Window): void {
    target.addEventListener('keydown', (event) => this.handle(event));
  }

  private handle(event: KeyboardEvent): void {
    const combo = comboFromEvent(event);
    const binding = this.bindings.find((item) => item.combo === combo);
    if (!binding) return;
    event.preventDefault();
    void this.commands.execute(binding.command, ...(binding.args ?? []));
  }
}
