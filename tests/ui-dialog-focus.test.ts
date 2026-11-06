import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPalette } from '../src/renderer/ui/palette';
import { createQuickOpen } from '../src/renderer/ui/quick-open';
import { createSymbolPicker } from '../src/renderer/ui/symbol-picker';
import { installMiniDom } from './helpers/mini-dom';

/**
 * Четыре оверлея окна — палитра команд, быстрое открытие, символы проекта и поиск
 * по смыслу — близнецы, и болеют они одинаково. Здесь проверяется ТО, ЧТО СЛЫШИТ
 * человек с читалкой и клавиатурой, на живых экземплярах в мини-DOM:
 *
 * 1. **Диалог объявлен.** Подложка без `role="dialog"` для читалки — просто
 *    затемнённый прямоугольник: она не скажет «вы вошли в диалог». Поле внутри
 *    не связано с ним подписью, так что имя диалога — единственное, за что
 *    зацепиться слухом.
 * 2. **Фокус возвращается.** Палитра забирает фокус в своё поле. Закрывшись по
 *    Escape, она оставляла его на `body` — и `Tab` начинал обход с верха
 *    страницы, а не с того места, где человек был. Мышь этого не видит.
 *
 * Проверка общая на всех: болезнь была одна, и лечилась она одним приёмом,
 * поэтому и страж один — иначе четвёртый оверлей отсохнет тихо.
 */

/** Кнопка, у которой «забрали» фокус, — как будто её нажали перед открытием. */
function ownerButton(): HTMLElement {
  const button = document.createElement('button');
  button.textContent = 'открыть';
  document.body.append(button);
  return button;
}

/** Открывает оверлей и проверяет, что он диалог. Возвращает само окно. */
function asDialog(element: HTMLElement, label: string): void {
  const panel = element.querySelector('.palette') as unknown as HTMLElement;
  expect(panel).toBeTruthy();
  expect(panel.getAttribute('role')).toBe('dialog');
  expect(panel.getAttribute('aria-modal')).toBe('true');
  // Подпись не пустая: диалог без имени читалка называет просто «диалог».
  expect(panel.getAttribute('aria-label')).toBe(label);
}

beforeEach(() => {
  installMiniDom();
});

describe('оверлеи объявлены диалогами', () => {
  it('палитра команд', () => {
    const palette = createPalette({
      commands: { list: () => [], run: vi.fn(), paletteVisible: () => [] } as never,
    } as never);
    asDialog(palette.element as unknown as HTMLElement, 'Палитра команд');
  });

  it('быстрое открытие', () => {
    const quick = createQuickOpen({
      rpc: { request: vi.fn(async () => []) } as never,
      workspace: { root: '/project' } as never,
      openFile: vi.fn(),
    } as never);
    asDialog(quick.element as unknown as HTMLElement, 'Быстрое открытие файла');
  });

  it('символы проекта', () => {
    const picker = createSymbolPicker({ rpc: { request: vi.fn(async () => []) } as never, openSymbol: vi.fn() } as never);
    asDialog(picker.element as unknown as HTMLElement, 'Символы проекта');
  });
});

describe('фокус возвращается тому, у кого его взяли', () => {
  it('символы проекта: после открытия — в поле, после закрытия — обратно на кнопку', () => {
    const button = ownerButton();
    button.focus();

    const picker = createSymbolPicker({ rpc: { request: vi.fn(async () => []) } as never, openSymbol: vi.fn() } as never);
    document.body.append(picker.element as unknown as HTMLElement);

    picker.open();
    const input = (picker.element as unknown as HTMLElement).querySelector('input') as unknown as HTMLElement;
    // Пока диалог открыт, клавиатура ищет здесь — это ожидаемо.
    expect(document.activeElement).toBe(input);

    picker.close();
    // А это — то, что было сломано: без возврата здесь остался бы `body`.
    expect(document.activeElement).toBe(button);
  });
});
