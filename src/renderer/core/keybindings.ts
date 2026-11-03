import type { KeybindingOverride } from '../../shared/keybindings';
import { rendererOverrides } from '../../shared/keybindings';
import { shortcutKey } from '../../shared/physical-key';
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

/**
 * Сочетание из нажатия. Клавиша берётся по ФИЗИЧЕСКОМУ положению (`event.code`), а не
 * по знаку раскладки: при русской раскладке `Ctrl+S` даёт `key === 'ы'`, и сочетание
 * разошлось бы со своим именем — команда не нашлась бы. Служебные клавиши (`F5`,
 * `Escape`) от раскладки не зависят, у них берётся `key`.
 */
export function comboFromEvent(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(shortcutKey(event));
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
/**
 * Положение, в котором действует своё сочетание.
 *
 * Дзен — пример: `Escape` в нём должен выйти, а вне его принадлежит редактору
 * (снять мультикурсор, закрыть поиск). Прописать `Escape` в умолчаниях нельзя —
 * он отнял бы клавишу у всего. Поэтому условие, а не безусловное сочетание.
 */
export interface ContextBinding extends Keybinding {
  /** Когда действует. Проверяется на КАЖДОЕ нажатие: положение меняется на ходу. */
  when(): boolean;
  /**
   * Уступить, если кто-то в фазе перехвата нажатие уже съел.
   *
   * Без этого одно `Escape` в дзене закрывало бы и окно поверх (его ловит
   * `ui/modal.ts` в фазе перехвата), и сам дзен: слушатель окна стоит раньше
   * модалки, но `preventDefault()` не мешает выполниться обоим. По эталону
   * очередь такая: окно/попап/поиск → дзен → обычный `Escape` редактора.
   */
  unlessHandled?: boolean;
}

export class KeybindingService {
  private readonly contexts: ContextBinding[] = [];

  constructor(
    private readonly commands: CommandRegistry,
    private readonly defaults: readonly Keybinding[],
    private readonly overrides: () => readonly KeybindingOverride[] = () => [],
  ) {}

  /**
   * Сочетание, которое действует только в своём положении.
   *
   * Спрашивается РАНЬШЕ умолчаний: в дзене `Escape` не должен одновременно
   * значить «снять мультикурсор» — иначе за одно нажатие случится два дела.
   */
  bindInContext(binding: ContextBinding): void {
    this.contexts.push(binding);
  }

  attach(target: Window): void {
    target.addEventListener('keydown', (event) => this.handle(event));
  }

  /**
   * Действующие сочетания: по умолчанию, с наложенными переопределениями renderer.
   * Команда с пустым сочетанием из списка выпадает — её сочетание снято.
   *
   * Переопределения клавиш МЕНЮ (`menu:...`) здесь не участвуют: их держит Electron,
   * и нажатие до renderer не доходит — иначе команда сработала бы дважды.
   *
   * Переопределение команды, которой в списке по умолчанию НЕ было, добавляет ей
   * сочетание: так человек назначает клавишу любой команде, а не только той, у которой
   * она уже была.
   */
  effective(): Keybinding[] {
    const overrides = new Map(rendererOverrides(this.overrides()).map((item) => [item.command, item.combo]));
    const result: Keybinding[] = [];
    for (const binding of this.defaults) {
      const combo = overrides.has(binding.command) ? overrides.get(binding.command)! : binding.combo;
      if (combo) result.push({ ...binding, combo });
      overrides.delete(binding.command);
    }
    // Что осталось — команды без сочетания по умолчанию: даём сочетание им.
    for (const [command, combo] of overrides) {
      if (combo) result.push({ combo, command });
    }
    return result;
  }

  private handle(event: KeyboardEvent): void {
    const combo = comboFromEvent(event);
    // Нажатие уже съедено раньше нас (окно, поиск в фазе перехвата) — дальше не
    // идём ВООБЩЕ: иначе одно Escape закрывало бы окно и снимало мультикурсор
    // в редакторе заодно. Очередь обрывается на том, кто съел.
    if (event.defaultPrevented) return;
    const contextual = this.contexts.find(
      (item) => item.combo === combo && item.when() && !(item.unlessHandled && event.defaultPrevented),
    );
    if (contextual) {
      event.preventDefault();
      void this.commands.execute(contextual.command, ...(contextual.args ?? []));
      return;
    }
    const binding = this.effective().find((item) => item.combo === combo);
    if (!binding) return;
    event.preventDefault();
    void this.commands.execute(binding.command, ...(binding.args ?? []));
  }
}
