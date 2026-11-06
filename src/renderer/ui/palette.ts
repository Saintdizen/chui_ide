import type { CommandDescriptor, CommandRegistry } from '../core/commands';
import { groupCommands, rankCommandMatches, type RankedCommand } from '../core/palette-rank';
import { listMove, optionId } from '../core/list-nav';
import { clear, dialogOverlay, h } from './dom';
import { focusOwner, returnFocus } from './focus-return';

/** Счётчик палитр на модуль: два окна в одном документе не должны делиться именами строк. */
let paletteSeq = 0;

/**
 * Что делает клик по сочетанию (п.1).
 *
 * `reclaim` — первое нажатие после показа окна: браузер отдаёт кликом возврат
 * фокуса в окно, и курсор может стоять где угодно. Выбирать строку в этот
 * момент значит увести в настройки случайную команду.
 */
export function keyHintPlan(sinceOpenMs: number, freshMs = 250): 'settings' | 'reclaim' {
  return sinceOpenMs < freshMs ? 'reclaim' : 'settings';
}

/**
 * Подпись у команды без сочетания. Молчать нельзя: человек видит, что клавиши
 * нет, и не знает, что её можно назначить — сочетание открываемо или никак.
 */
export function keyHintLabel(descriptor: CommandDescriptor): string {
  return descriptor.keybinding ?? 'назначить клавишу';
}

export interface PaletteView {
  element: HTMLElement;
  open(): void;
  close(): void;
  /**
   * Когда палитру открыли (мс, `performance.now()`). Окно сверяет с ним первые
   * клики: браузер отдаёт кликом возврат фокуса в окно, и первое такое нажатие
   * не должно выбирать строку под курсором.
   */
  openedAt(): number | null;
  /** Очистить запрос и вернуть фокус в поле — очередь «я ещё печатаю». */
  clearQuery(): void;
}

/**
 * Сколько пунктов показывать. Сорока стало мало: к нашим командам добавляются действия
 * редактора, и при пустом поле хвост списка просто отрезался (живой замер — 231 пункт).
 * Теперь это только страховка от отрисовки: предел выше
 * любого реального списка, а сужает выдачу сам поиск.
 */
const MAX_ITEMS = 500;

/**
 * Почему список пуст (TASKS 10).
 *
 * «Ничего не найдено» — ответ на запрос, а не на молчание реестра. Разница
 * важна: на пустом реестре эта фраза говорит «такой команды нет», хотя их
 * нет ВООБЩЕ — человек идёт и ищет глубже, вместо того чтобы понять,
 * что реестр не наполнился, и сообщить об этом.
 */
export function paletteEmptyReason(total: number, query: string): string {
  if (total === 0) return 'Команд нет вовсе — палитре нечего показывать';
  if (query !== '') return 'Ничего не найдено';
  // Запрос пуст, а показывать нечего: значит пуст не реестр, а выборка.
  return 'Все команды скрыты из палитры';
}

/**
 * Палитра команд (Ctrl+Shift+P). Работает поверх реестра команд,
 * поэтому любая новая команда появляется здесь автоматически.
 */
export function createPalette(deps: {
  commands: CommandRegistry;
  /** История запусков: недавние команды показываются сверху. Нет — порядок регистрации. */
  recent?: { ids(): readonly string[]; remember(id: string): void };
  /**
   * Зовётся перед показом, и только потом строится список: приложению есть когда
   * сохранить историю (одной записью, а не на каждый запуск) и обновить настройки.
   */
  onBeforeShow?: () => void;
  /**
   * Открыть настройки клавиш для команды (п.1: сочетание в палитре кликабельно)
   * и вернуть признак «успели до того, как человек дописал запрос».
   */
  openKeybindingSettings?: (command: string) => boolean;
}): PaletteView {
  const input = h('input', {
    class: 'palette-input',
    type: 'text',
    placeholder: 'Введите команду…',
    spellcheck: false,
    // Поле запроса — часть списка, а не отдельный поиск: `combobox` с
    // `aria-controls` на список. Без этого читалка называла «Введите команду…»
    // и молчала о том, что звучащее дальше — варианты.
    role: 'combobox',
    'aria-expanded': 'true',
    'aria-autocomplete': 'list',
    'aria-label': 'Команда',
  });
  // Идентификатор списка нужен ссылкам `aria-controls`/`activedescendant`.
  // Счётчик на модуль, а не на экземпляр: палитра одна, но порядок в тестах
  // не должен зависеть от соседей в том же документе.
  const listId = `palette-list-${++paletteSeq}`;
  const list = h('div', { class: 'palette-list', role: 'listbox', id: listId });
  input.setAttribute('aria-controls', listId);
  const overlay = dialogOverlay(h('div', { class: 'palette' }, input, list), {
    label: 'Палитра команд',
  });

  // Совпадения вместе с тем, что подсветить: две формы одного списка
  // разошлись бы на первой же правке.
  let matches: RankedCommand[] = [];
  let cursor = 0;
  /** Последний нарисованный заголовок группы: повтор подряд — это шум. */
  let lastHeader = '';

  const run = (descriptor: CommandDescriptor): void => {
    // Недоступную команду не запускаем ни кликом, ни Enter: она уже показана серой.
    if (!deps.commands.isEnabled(descriptor.id)) return;
    deps.recent?.remember(descriptor.id);
    close();
    void deps.commands.execute(descriptor.id);
  };

  /**
   * Название с подсвеченными буквами. Позиции — индексы символов названия,
   * уже переведённые из свёрнутой формы в исходную (`palette-rank`).
   */
  const highlighted = (title: string, positions: readonly number[]): (Node | string)[] => {
    if (positions.length === 0) return [title];
    const hits = new Set(positions);
    const parts: (Node | string)[] = [];
    let plain = '';
    [...title].forEach((char, index) => {
      if (hits.has(index)) {
        if (plain) parts.push(plain);
        plain = '';
        parts.push(h('mark', {}, char));
        return;
      }
      plain += char;
    });
    if (plain) parts.push(plain);
    return parts;
  };

  const render = (): void => {
    clear(list);
    lastHeader = '';
    const query = input.value.trim();
    const recent = deps.recent?.ids() ?? [];
    // Без запроса ищем по истории: человек, живущий в двух командах, не должен
    // каждый раз искать их заново. С запросом порядок задаёт совпадение —
    // иначе редкая команда с точным совпадением пряталась бы под привычными.
    // Палитра показывает реестр, но не служебное: `hidden` — это решение с причиной,
    // а не забывчивость. Считаем один раз — порядок и состав должны совпадать.
    const visible = deps.commands.paletteVisible();
    const ranked = rankCommandMatches(visible, query, recent, MAX_ITEMS);
    // Заголовки групп — только без запроса: с запросом порядок задаёт
    // релевантность, и заголовок разорвал бы её. А пустой экран — это больше
    // двухсот команд подряд, и категории в нём единственный ориентир.
    const grouped = query === '';

    // Одна раскладка на всё: из неё же берётся и порядок пунктов, и где ставить
    // заголовок. Считать её дважды — значит рано или поздно показать заголовок
    // не от той группы.
    const groups = grouped ? groupCommands(visible, recent) : [];
    const headers: (string | null)[] = grouped ? groups.flatMap((group) => group.items.map(() => group.header)) : [];
    matches = grouped
      ? groups
          .flatMap((group) => group.items.map((descriptor) => ({ descriptor, positions: [] as number[] })))
          .slice(0, MAX_ITEMS)
      : [...(ranked ?? [])];

    cursor = Math.min(cursor, Math.max(matches.length - 1, 0));

    matches.forEach(({ descriptor, positions }, index) => {
      const header = headers[index];
      if (header && header !== lastHeader) {
        lastHeader = header;
        list.appendChild(h('div', { class: 'palette-group' }, header));
      }
      const disabled = !deps.commands.isEnabled(descriptor.id);
      const item = h(
        'button',
        {
          class: `palette-item${index === cursor ? ' is-active' : ''}${disabled ? ' is-disabled' : ''}`,
          type: 'button',
          // `option` + `aria-selected`: текущий вариант назван, ЕСЛИ у списка
          // есть `activedescendant`. Он ставится ниже, после отрисовки.
          id: optionId(listId, index),
          role: 'option',
          'aria-selected': index === cursor ? 'true' : 'false',
          // Недоступная команда не `disabled`: `disabled` на `option` читалка
          // пропускает МОЛЧА, и человек не узнает ни что команда есть, ни
          // почему не выбирается. `aria-disabled` её сохраняет в списке.
          'aria-disabled': disabled ? 'true' : undefined,
          disabled,
        },
        // Подсветка — ответ на «почему эта команда тут»: без неё нечёткое
        // совпадение (`свн`) выглядит как случайная строка в списке.
        h('span', { class: 'palette-item-title' }, ...highlighted(descriptor.title, positions)),
        // Категория у пункта не нужна, когда она уже стоит заголовком группы.
        grouped ? null : h('span', { class: 'palette-item-category' }, descriptor.category),
        deps.openKeybindingSettings || descriptor.keybinding
          ? h(
              'span',
              { class: `palette-item-key${descriptor.keybinding ? '' : ' is-unbound'}` },
              keyHintLabel(descriptor),
            )
          : null,
      );
      item.addEventListener('click', () => run(descriptor));
      // Клик по сочетанию уводит в настройки клавиш — там его и меняют. Внутри
      // пункта, а не отдельной строкой: человек в этот момент смотрит на клавишу.
      const keyHint = item.querySelector('.palette-item-key');
      if (keyHint && deps.openKeybindingSettings) {
        keyHint.addEventListener('click', (event) => {
          event.stopPropagation();
          // Решение — чистой функцией: в прогоне без DOM проверяется она одна.
          if (keyHintPlan(performance.now() - (openedAt ?? 0)) === 'reclaim') {
            clearQuery();
            return;
          }
          close();
          // Отказ приложения (окликнули повторно) — палитра вернула фокус в поле.
          if (deps.openKeybindingSettings?.(descriptor.id) === false) {
            open();
          }
        });
      }
      item.addEventListener('mousemove', () => {
        if (cursor === index) return;
        cursor = index;
        render();
      });
      list.appendChild(item);
    });

    if (matches.length === 0) {
      // Причина важнее вывода (п.10): «Ничего не найдено» на пустом реестре
      // читается как «такой команды нет», хотя их нет ВООБЩЕ.
      list.appendChild(h('div', { class: 'palette-empty' }, paletteEmptyReason(visible.length, query)));
    }

    // Текущая строка называется идентификатором, а не «фокусом»: фокус остаётся
    // в поле запроса, иначе печатать было бы некуда. Это и есть APG-разметка
    // `combobox` + `listbox`: `activedescendant` — единственный способ сообщить
    // читалке, какой из вариантов сейчас подсвечен.
    if (matches.length > 0) input.setAttribute('aria-activedescendant', optionId(listId, cursor));
    else input.removeAttribute('aria-activedescendant');
  };

  input.addEventListener('input', () => {
    cursor = 0;
    render();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const picked = matches[cursor];
      if (picked) run(picked.descriptor);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else {
      // Стрелки, Home/End и страницы — по тому же правилу, что у остальных
      // списков (`core/list-nav`). Подсветка по краям обёрнута: «уперся в
      // край» читается как поломка, а не как конец списка.
      const move = listMove(event.key, cursor, matches.length);
      if (move === null || move.kind !== 'to') return;
      event.preventDefault();
      cursor = move.index;
      render();
    }
  });

  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) close();
  });

  // Чей был фокус до открытия: берём ДО того, как он уйдёт в поле запроса.
  let owner: HTMLElement | null = null;
  /**
   * Когда палитру открыли. Нужен, чтобы отличить клик по сочетанию от клика,
   * которым человек просто возвращает фокус в окно: браузер отдаёт такое
   * нажатие как click по тому, что окажется под курсором.
   */
  let openedAt: number | null = null;

  function open(): void {
    // Сначала повод приложению (сохранить историю, обновить настройки), потом список:
    // иначе палитра покажет устаревший порядок на один запуск.
    deps.onBeforeShow?.();
    owner = focusOwner();
    overlay.hidden = false;
    input.value = '';
    cursor = 0;
    openedAt = performance.now();
    render();
    input.focus();
  }

  function close(): void {
    // Пока попап открыт, фокус в его поле. Вернуть его тому, кто открыл палитру, —
    // иначе после Escape клавиатура начинает обход с верха страницы.
    overlay.hidden = true;
    returnFocus(owner);
    owner = null;
  }

  render();

  function clearQuery(): void {
    input.value = '';
    cursor = 0;
    openedAt = performance.now();
    render();
    input.focus();
  }

  return { element: overlay, open, close, openedAt: () => openedAt, clearQuery };
}
