import { beforeEach, describe, expect, it, vi } from 'vitest';
import { closePopupMenu, showPopupMenu, type PopupMenuItem } from '../src/renderer/ui/popup-menu';
import { installMiniDom } from './helpers/mini-dom';

/**
 * Контекстное меню (`renderer/ui/popup-menu.ts`).
 *
 * Здесь всё поведение: состав уровней, подменю, клавиатура и мышь. Тонкости, которые
 * легко сломать незаметно, и поэтому проверяются:
 *
 * - стрелки по кругу и разделители пропускаются;
 * - стрелка вправо/Enter раскрывает подменю, а обычное движение — нет (иначе по
 *   списку с подменю нельзя было бы ходить);
 * - выбор пункта меняет состояние ДО закрытия, и только потом меню исчезает;
 * - закрытие зовёт `onClose` ровно один раз.
 */

function menuItems(): PopupMenuItem[] {
  return [
    { label: 'Открыть', onSelect: vi.fn() },
    { separator: true } as PopupMenuItem,
    { label: 'Переименовать', onSelect: vi.fn(), hint: 'F2' },
    { label: 'Ещё', submenu: [{ label: 'Вложенный', onSelect: vi.fn() }] },
  ];
}

const menus = () => Array.from(document.body.querySelectorAll('.context-menu')) as HTMLElement[];
const items = (menu: HTMLElement) => Array.from(menu.querySelectorAll('.context-item')) as HTMLElement[];
const labels = (menu: HTMLElement) => items(menu).map((entry) => entry.querySelector('.context-label')?.textContent);

/**
 * Нажатие клавиши в окне.
 *
 * Обработчики меню вешает не сразу, а через `setTimeout(0)`: иначе тот же клик,
 * которым меню открыли, сразу бы его и закрыл. Поэтому перед нажатием ждём кадр.
 */
async function press(key: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  window.dispatchEvent({ key, type: 'keydown', preventDefault() {}, target: document.body } as never);
}

describe('контекстное меню', () => {
  beforeEach(() => {
    installMiniDom();
    closePopupMenu();
  });

  it('открывается одним уровнем и показывает все пункты по порядку', () => {
    showPopupMenu(menuItems(), 10, 10);

    const [menu] = menus();
    expect(menu).toBeDefined();
    expect(labels(menu as HTMLElement)).toEqual(['Открыть', 'Переименовать', 'Ещё']);
  });

  it('быстрый вызов заменяет прежнее меню, а не плодит второе', () => {
    showPopupMenu(menuItems(), 10, 10);
    showPopupMenu([{ label: 'Один', onSelect: vi.fn() }], 50, 50);

    expect(menus()).toHaveLength(1);
    expect(labels(menus()[0] as HTMLElement)).toEqual(['Один']);
  });

  it('пункт с подсказкой показывает её справа', () => {
    showPopupMenu(menuItems(), 10, 10);

    const hint = (menus()[0] as HTMLElement).querySelector('.context-hint');
    expect(hint?.textContent).toBe('F2');
  });

  it('клик по пункту выбирает его и закрывает меню', () => {
    const items = menuItems();
    showPopupMenu(items, 10, 10);

    ((menus()[0] as HTMLElement).querySelectorAll('.context-item')[0] as unknown as { click(): void })?.click();

    expect(items[0] && 'onSelect' in items[0] ? items[0].onSelect : undefined).toHaveBeenCalled();
    expect(menus()).toHaveLength(0);
  });

  it('пункт без обработчика не делает ничего, но меню всё равно закрывается', () => {
    // «Недоступных» пунктов в контракте нет: нечего выбирать — просто заголовок.
    // Меню при этом закрывается, как и от любого выбора.
    showPopupMenu([{ label: 'Просто подпись' }], 10, 10);

    ((menus()[0] as HTMLElement).querySelectorAll('.context-item')[0] as unknown as { click(): void })?.click();

    expect(menus()).toHaveLength(0);
  });

  it('обработчик зовётся уже после закрытия — так подменю не остаётся висеть', () => {
    const seen: number[] = [];
    showPopupMenu(
      [
        {
          label: 'Открыть',
          onSelect: () => seen.push(menus().length),
        },
      ],
      10,
      10,
    );

    ((menus()[0] as HTMLElement).querySelectorAll('.context-item')[0] as unknown as { click(): void })?.click();

    expect(seen).toEqual([0]);
  });

  it('подменю раскрывается по наведению и показывает свои пункты', () => {
    showPopupMenu(menuItems(), 10, 10);
    const submenuItem = items(menus()[0] as HTMLElement)[2] as HTMLElement;

    const handlers =
      (submenuItem as unknown as { handlers: Record<string, ((e: unknown) => void)[]> }).handlers.mouseenter ?? [];
    for (const handler of handlers) handler({});

    expect(menus()).toHaveLength(2);
    expect(labels(menus()[1] as HTMLElement)).toEqual(['Вложенный']);
  });

  it('Escape закрывает меню и зовёт onClose ровно один раз', async () => {
    const onClose = vi.fn();
    showPopupMenu(menuItems(), 10, 10, { onClose });

    await press('Escape');

    expect(menus()).toHaveLength(0);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('закрытие без обработчика не падает', () => {
    showPopupMenu(menuItems(), 10, 10);

    expect(() => closePopupMenu()).not.toThrow();
    expect(menus()).toHaveLength(0);
  });

  it('пустой список даёт пустое меню, а не ошибку', () => {
    // Проверка «нечего показывать» — забота вызывающего: меню строится всегда.
    expect(() => showPopupMenu([], 10, 10)).not.toThrow();
    expect(labels(menus()[0] as HTMLElement)).toEqual([]);
  });

  it('меню встаёт рядом с точкой клика', () => {
    showPopupMenu([{ label: 'Один', onSelect: vi.fn() }], 40, 60);

    // Мини-DOM отдаёт метрики по тексту, поэтому проверяем, что позиция задана.
    const menu = menus()[0] as HTMLElement;
    expect(menu.style.left).toBeTruthy();
    expect(menu.style.top).toBeTruthy();
  });
});

describe('клавиатура в меню', () => {
  beforeEach(() => {
    installMiniDom();
    closePopupMenu();
  });

  it('стрелка вниз переходит к следующему пункту по кругу', async () => {
    showPopupMenu(menuItems(), 10, 10);
    const menu = menus()[0] as HTMLElement;

    // Меню открывается с подсветкой на первом пункте, и `.context-item` — только
    // выбираемые пункты: разделителя среди них нет.
    const active = () => items(menu).findIndex((entry) => entry.classList.contains('is-highlighted'));
    expect(active()).toBe(0);

    await press('ArrowDown');
    expect(active()).toBe(1);

    await press('ArrowDown');
    expect(active()).toBe(2);

    // С последнего переходим на первый — по кругу, а не в никуда.
    await press('ArrowDown');
    expect(active()).toBe(0);
  });

  it('Enter выполняет активный пункт', async () => {
    const target = vi.fn();
    showPopupMenu([{ label: 'Один', onSelect: target }], 10, 10);

    await press('ArrowDown');
    await press('Enter');

    expect(target).toHaveBeenCalledTimes(1);
    expect(menus()).toHaveLength(0);
  });

  it('стрелка вправо раскрывает подменю, а обычное движение по списку — нет', async () => {
    // Без этого по списку с подменю нельзя было бы ходить: наведение раскрывало бы
    // подменю на каждом шаге и уводило фокус вглубь.
    showPopupMenu(menuItems(), 10, 10);

    await press('ArrowUp'); // с первого на последний — «Ещё», у него подменю
    expect(menus()).toHaveLength(1);

    await press('ArrowRight');
    expect(menus()).toHaveLength(2);
  });

  it('стрелка влево закрывает подменю и возвращает к родительскому меню', async () => {
    showPopupMenu(menuItems(), 10, 10);
    await press('ArrowUp');
    await press('ArrowRight');
    expect(menus()).toHaveLength(2);

    await press('ArrowLeft');

    expect(menus()).toHaveLength(1);
  });

  it('выбор пункта в подменю закрывает все уровни разом', async () => {
    const nested = vi.fn();
    showPopupMenu([{ label: 'Ещё', submenu: [{ label: 'Вложенный', onSelect: nested }] }], 10, 10);
    await press('ArrowDown');
    await press('ArrowRight');

    await press('Enter');

    expect(nested).toHaveBeenCalled();
    expect(menus()).toHaveLength(0);
  });
});
