/**
 * Куда вернуть фокус, когда попап закрылся.
 *
 * Палитра, быстрое открытие, меню — все забирают фокус к себе и, закрывшись,
 * оставляют его на `body`. Клавиатурный человек после Escape оказывается в
 * никуда: `Tab` начинает обход с верха страницы, а не с того места, где он был.
 * Мышь такое не замечает — потому этот дефект и живёт так долго.
 *
 * Модуль чистый: ни DOM-слушателей, ни побочек — только «чей фокус» и «верни».
 */

/** Элемент, у которого забирают фокус, — или `null`, если его не было. */
export function focusOwner(element: Element | null = document.activeElement): HTMLElement | null {
  if (!element?.isConnected) return null;
  // `body` владельцем не считается: это фокус «ничей», вернуть его некуда.
  if (element === document.body || element === document.documentElement) return null;
  // Проверяем ФОРМУ, а не `instanceof HTMLElement`: модуль годится и там, где
  // глобального класса нет (тесты без DOM) — а таких вызовов у нас много.
  const candidate = element as Partial<HTMLElement>;
  if (typeof candidate.focus !== 'function') return null;
  return element as HTMLElement;
}

/**
 * Вернуть фокус владельцу. Пропускаем, если элемент уже ушёл из документа:
 * попап мог закрыться ПОСЛЕ того, как открывшую его кнопку убрали с экрана
 * (перерисовали панель), и `focus()` на отвязанном узле молча ничего не делает.
 */
export function returnFocus(to: HTMLElement | null): void {
  if (to?.isConnected && typeof to.focus === 'function') to.focus();
}
