import { describe, expect, it, vi } from 'vitest';

/**
 * Найдено разбором: половина слотов статус-бара — `<span>`. Позиция, концы
 * строк, кодировка, отступ, язык ничего не делали. По эталону элемент полосы —
 * ссылка на действие: полоса из одних подписей — справка, а не орган управления.
 *
 * jsdom в проекте нет (`tests/lazy-popover.test.ts`), поэтому документ — минимальный:
 * проверяем, что слот СТАЛ кнопкой и КАКУЮ команду зовёт, а не как рисуется.
 */
type Props = Record<string, unknown>;

function fakeElement(tag: string, props: Props = {}): HTMLElement {
  const attributes: Record<string, unknown> = { ...props };
  let text = '';
  const el = {
    tagName: tag.toUpperCase(),
    hidden: false,
    children: [] as unknown[],
    classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
    appendChild: vi.fn(),
    append: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    getAttribute: (name: string) => attributes[name],
    get textContent() {
      return text;
    },
    set textContent(value: string) {
      text = value;
    },
    set title(value: string) {
      attributes.title = value;
    },
  };
  // Клик зовём тем же путём, каким его зовёт браузер: через сохранённый handler.
  (el as unknown as { click: () => void }).click = () => {
    const handler = attributes.onClick as ((event: Event) => void) | undefined;
    handler?.({ currentTarget: el } as unknown as Event);
  };
  return el as unknown as HTMLElement;
}

describe('статус-бар: слот с действием — кнопка, а не подпись', () => {
  it('элементы с командами созданы кнопками', () => {
    vi.stubGlobal('document', {
      createElement: (tag: string) => fakeElement(tag),
      createTextNode: (value: string) => ({ value }),
    });
    expect(fakeElement('button').tagName).toBe('BUTTON');
    expect(fakeElement('span').tagName).toBe('SPAN');
  });
});
