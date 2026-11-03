import { describe, expect, it, vi } from 'vitest';

/**
 * Найдено разбором: палитра, быстрое открытие, попапы и меню забирали фокус к
 * себе, а при закрытии не возвращали. Для мыши незаметно; для клавиатуры — после
 * Escape следующий Tab идёт с верха страницы, а не с того места, где человек был.
 *
 * jsdom в проекте нет (см. `tests/lazy-popover.test.ts`), поэтому `document`
 * подменяется минимальным: проверяем ЛОГИКУ выбора владельца, а не браузер.
 */
function withFakeDocument(body: unknown, root: unknown, active: unknown): void {
  vi.stubGlobal('document', { body, documentElement: root, activeElement: active });
  vi.stubGlobal('HTMLElement', FakeElement);
}

class FakeElement {
  isConnected = true;
  focus = vi.fn();
}

describe('focusOwner', () => {
  it('обычный элемент — владелец фокуса', async () => {
    const button = new FakeElement();
    const body = new FakeElement();
    withFakeDocument(body, new FakeElement(), button);
    const { focusOwner } = await import('../src/renderer/ui/focus-return');
    expect(focusOwner()).toBe(button);
  });

  it('body владельцем не считается: фокуса «нигде» не вернуть', async () => {
    // Иначе после Escape фокус «возвращался» бы в body — то есть никуда, и
    // дефект выглядел бы закрытым, ничего не исправив.
    const body = new FakeElement();
    withFakeDocument(body, new FakeElement(), body);
    const { focusOwner } = await import('../src/renderer/ui/focus-return');
    expect(focusOwner()).toBeNull();
  });

  it('html владельцем не считается', async () => {
    const root = new FakeElement();
    withFakeDocument(new FakeElement(), root, root);
    const { focusOwner } = await import('../src/renderer/ui/focus-return');
    expect(focusOwner()).toBeNull();
  });

  it('null — владельца нет', async () => {
    withFakeDocument(null, null, null);
    const { focusOwner } = await import('../src/renderer/ui/focus-return');
    expect(focusOwner(null)).toBeNull();
  });

  it('в явно переданном аргументе document не участвует', async () => {
    withFakeDocument(new FakeElement(), new FakeElement(), null);
    const button = new FakeElement();
    const { focusOwner } = await import('../src/renderer/ui/focus-return');
    expect(focusOwner(button as unknown as Element)).toBe(button);
  });
});

describe('returnFocus', () => {
  it('возвращает фокус владельцу', async () => {
    withFakeDocument(null, null, null);
    const { returnFocus } = await import('../src/renderer/ui/focus-return');
    const button = new FakeElement();
    returnFocus(button as unknown as HTMLElement);
    expect(button.focus).toHaveBeenCalledTimes(1);
  });

  it('ушедший из документа элемент не трогаем', async () => {
    // Панель могла перерисоваться, пока попап был открыт: focus() на отвязанном
    // узле молча ничего не делает, и фокус остаётся на body.
    withFakeDocument(null, null, null);
    const { returnFocus } = await import('../src/renderer/ui/focus-return');
    const gone = new FakeElement();
    gone.isConnected = false;
    returnFocus(gone as unknown as HTMLElement);
    expect(gone.focus).not.toHaveBeenCalled();
  });

  it('null — ничего не ломается', async () => {
    withFakeDocument(null, null, null);
    const { returnFocus } = await import('../src/renderer/ui/focus-return');
    expect(() => returnFocus(null)).not.toThrow();
  });
});

describe('поиск в чате возвращает фокус открывшему', () => {
  /**
   * Найдено разбором: `chat-find-bar.ts` закрывался, не возвращая фокус —
   * он падал в `<body>`, и `Tab` начинал обход с самого верха приложения.
   * Модалка, палитра, popup-menu, quick-open это уже делали через
   * `focus-return`, а поиск в чате — нет.
   */
  it('при закрытии фокус возвращается владельцу', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL('../src/renderer/ui/chat-find-bar.ts', import.meta.url), 'utf8');
    // Запомнили при открытии...
    expect(text).toMatch(/owner = focusOwner\(\)/);
    // ...и вернули при закрытии.
    expect(text).toMatch(/returnFocus\(owner\)/);
  });

  it('владелец запоминается ДО того, как фокус уйдёт в поле поиска', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL('../src/renderer/ui/chat-find-bar.ts', import.meta.url), 'utf8');
    const open = text.slice(text.indexOf('owner = focusOwner()'));
    // `input.focus()` стоит ПОСЛЕ запоминания: иначе владельцем стало бы само
    // поле поиска, и возвращать было бы некуда.
    expect(open.indexOf('input.focus()')).toBeGreaterThan(0);
  });
});
