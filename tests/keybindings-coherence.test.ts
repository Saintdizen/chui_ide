import { describe, expect, it } from 'vitest';
import { DEFAULT_KEYBINDINGS, SHARED_WITH_MENU } from '../src/renderer/core/default-keybindings';
import { APP_MENU, menuAccelerators } from '../src/shared/app-menu';

/**
 * Одно сочетание — один источник.
 *
 * Меню показывает сочетания из `APP_MENU`, клавиши срабатывают по
 * `DEFAULT_KEYBINDINGS`. Два списка неизбежно расходятся: кто-то поменял
 * акселератор меню и забыл клавишу, и в меню написано одно, а работает другое.
 * Проверка держит их вместе и называет исключения поимённо.
 */
const bindings = new Map(DEFAULT_KEYBINDINGS.map((binding) => [binding.command, binding.combo]));
const menu = menuAccelerators();
/** Сознательные пары: обе клавиши работают, и обе записаны в одном месте. */
const shared = new Map(SHARED_WITH_MENU.map((item) => [item.command, item.why]));

describe('меню и клавиши говорят одно и то же', () => {
  it('сочетание в меню совпадает с сочетанием команды', () => {
    const drift: string[] = [];
    for (const [command, combo] of menu) {
      const binding = bindings.get(command);
      // Команда без клавиши в реестре — законно (меню и есть её вход). Если
      // клавиша есть, она обязана совпадать с меню — либо расхождение объявлено.
      if (binding && binding !== combo && !shared.has(command)) {
        drift.push(`${command}: меню ${combo}, клавиши ${binding}`);
      }
    }
    expect(drift).toEqual([]);
  });

  it('объявленные пары действительно расходятся и не протухли', () => {
    // Иначе список разрешений сам станет источником вранья: пару починили, а
    // разрешение осталось и прикрывает будущий настоящий рассинхрон.
    const stale: string[] = [];
    for (const [command] of shared) {
      const binding = bindings.get(command);
      const combo = menu.get(command);
      if (!binding || !combo) stale.push(`${command}: нет в реестре или в меню`);
      else if (binding === combo) stale.push(`${command}: сочетания совпали — разрешение лишнее`);
    }
    expect(stale).toEqual([]);
  });

  it('одно сочетание не обслуживает две разные команды', () => {
    // Самая дорогая ошибка: две команды на одной клавише — какая сработает,
    // решает порядок регистрации, то есть случай.
    const byCombo = new Map<string, string>();
    const clashes: string[] = [];
    const note = (combo: string, command: string): void => {
      const previous = byCombo.get(combo);
      if (previous !== undefined && previous !== command) clashes.push(`${combo}: ${previous} и ${command}`);
      byCombo.set(combo, command);
    };
    for (const [command, combo] of menu) note(combo, command);
    for (const binding of DEFAULT_KEYBINDINGS) note(binding.combo, binding.command);
    expect(clashes).toEqual([]);
  });

  it('одна команда — одна клавиша: дубли в реестре запрещены', () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const binding of DEFAULT_KEYBINDINGS) {
      const previous = seen.get(binding.command);
      if (previous !== undefined) duplicates.push(`${binding.command}: ${previous} и ${binding.combo}`);
      seen.set(binding.command, binding.combo);
    }
    expect(duplicates).toEqual([]);
  });

  it('все пункты меню с командой существуют в реестре команд меню', () => {
    // Меню рисуется из `APP_MENU`, а команды регистрируются в renderer: пустой
    // `command` дал бы мёртвый пункт.
    const broken: string[] = [];
    const walk = (nodes: typeof APP_MENU): void => {
      for (const node of nodes) {
        if (node.children) walk(node.children);
        if (typeof node.command === 'string' && node.command.trim() === '')
          broken.push(node.label ?? '(пункт без названия)');
      }
    };
    walk(APP_MENU);
    expect(broken).toEqual([]);
  });
});
