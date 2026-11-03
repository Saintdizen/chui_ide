import { h, svgIcon } from './dom';
import { countMatches, stepIndex } from '../../shared/chat-find';

/**
 * Поиск по ленте беседы — полоса, которая встаёт над полем ввода.
 *
 * Чем отличается от поиска по беседам (`chat-tabs.ts`): тот ищет по ВСЕМ
 * беседам и открывает нужную, а этот — по сообщениям той, что открыта сейчас.
 * Поэтому `Ctrl+F` попадает сюда.
 *
 * Правила подсчёта и перехода — в `shared/chat-find.ts` (чистые функции): здесь
 * только разметка и фокус.
 */

export interface ChatFindTarget {
  /** Текст сообщения, в котором ищем. */
  text: string;
  /** Элемент, к которому прокручиваем. */
  element: HTMLElement;
}

export interface ChatFindBar {
  element: HTMLElement;
  /** Открыть полосу (`Ctrl+F`): встать в поле и выделить прежний запрос. */
  open(): void;
  close(): void;
  readonly isOpen: boolean;
  /** Лента изменилась — пересобрать список сообщений. */
  refresh(): void;
}

export interface ChatFindDeps {
  /** Сообщения открытой беседы в порядке ленты. */
  targets(): readonly ChatFindTarget[];
  /** Перейти к совпадению: прокрутить и подсветить именно его. */
  reveal(target: ChatFindTarget, query: string, matchIndex: number): void;
  /** Снять подсветку со всей ленты. */
  clearHighlight(): void;
  /** Поиск закрыт — вернуть фокус в поле ввода. */
  onClose(): void;
}

export function createChatFindBar(deps: ChatFindDeps): ChatFindBar {
  let targetList: readonly ChatFindTarget[] = [];
  /** Где стоим: сообщение и совпадение внутри него. -1 — нигде. */
  let messageIndex = -1;
  let matchIndex = -1;
  let isOpen = false;

  const input = h('input', {
    class: 'chat-find-input',
    type: 'text',
    placeholder: 'Найти в беседе',
    'aria-label': 'Поиск по беседе',
  }) as HTMLInputElement;

  const counter = h('span', { class: 'chat-find-counter' });
  const prev = h(
    'button',
    { class: 'chat-find-button', type: 'button', title: 'Предыдущее (Shift+Enter)', 'aria-label': 'Предыдущее' },
    svgIcon('arrowUp', 14),
  );
  const next = h(
    'button',
    { class: 'chat-find-button', type: 'button', title: 'Следующее (Enter)', 'aria-label': 'Следующее' },
    svgIcon('arrowDown', 14),
  );
  const closeButton = h(
    'button',
    { class: 'chat-find-button', type: 'button', title: 'Закрыть (Esc)', 'aria-label': 'Закрыть поиск' },
    svgIcon('close', 14),
  );

  const element = h('div', { class: 'chat-find', hidden: true }, input, counter, prev, next, closeButton);

  /** Сколько всего совпадений по всем сообщениям — для «3 из 12». */
  function totalMatches(query: string): number {
    let total = 0;
    for (const target of targetList) total += countMatches(target.text, query);
    return total;
  }

  /** Номер текущего совпадения среди всех: счётчик должен знать общий счёт. */
  function flatIndex(query: string): number {
    let offset = 0;
    for (let index = 0; index < messageIndex && index < targetList.length; index += 1) {
      offset += countMatches(targetList[index]!.text, query);
    }
    return offset + matchIndex;
  }

  function updateCounter(query: string): void {
    if (query.length === 0) {
      counter.textContent = '';
      counter.classList.remove('is-empty');
      return;
    }
    const total = totalMatches(query);
    if (total === 0) {
      counter.textContent = 'нет';
      counter.classList.add('is-empty');
      return;
    }
    counter.classList.remove('is-empty');
    counter.textContent = `${flatIndex(query) + 1} из ${total}`;
  }

  function clearAll(): void {
    if (messageIndex >= 0) deps.clearHighlight();
    messageIndex = -1;
    matchIndex = -1;
  }

  /**
   * Встать на совпадение с ПЛОСКИМ номером, разложив его по сообщениям.
   *
   * Так переход «дальше» на границе двух сообщений не спотыкается о конец
   * ленты: шагаем по общему счёту, а не по массиву сообщений.
   */
  function selectFlat(query: string, flat: number): void {
    let left = flat;
    for (let index = 0; index < targetList.length; index += 1) {
      const target = targetList[index]!;
      const count = countMatches(target.text, query);
      if (left < count) {
        messageIndex = index;
        matchIndex = left;
        deps.reveal(target, query, left);
        return;
      }
      left -= count;
    }
    clearAll();
  }

  function step(delta: number): void {
    const query = input.value;
    if (query.length === 0) return;
    const total = totalMatches(query);
    if (total === 0) {
      updateCounter(query);
      return;
    }
    const current = messageIndex >= 0 ? flatIndex(query) : -1;
    selectFlat(query, stepIndex(current, total, delta));
    updateCounter(query);
  }

  /**
   * Запрос изменился. Пересобираем список сообщений заново — за время между
   * нажатиями лента могла дорисоваться. Совпадения сбрасываем: прежние
   * позиции относятся к старому запросу и соврут.
   */
  function search(): void {
    refresh();
    clearAll();
    const query = input.value;
    if (query.length === 0 || totalMatches(query) === 0) {
      updateCounter(query);
      return;
    }
    selectFlat(query, 0);
    updateCounter(query);
  }

  function refresh(): void {
    targetList = deps.targets();
  }

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    element.hidden = true;
    clearAll();
    counter.textContent = '';
    counter.classList.remove('is-empty');
    input.value = '';
    deps.onClose();
  }

  input.addEventListener('input', () => search());
  input.addEventListener('keydown', (event) => {
    // Enter переходит, Esc закрывает — как в поиске браузера. Без preventDefault
    // Enter ушёл бы дальше по форме: рядом поле ввода сообщения.
    if (event.key === 'Enter') {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });
  prev.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));
  closeButton.addEventListener('click', () => close());

  return {
    element,
    open() {
      if (isOpen) {
        // Второй Ctrl+F не гасит поиск, а возвращает в его поле.
        input.focus();
        input.select();
        return;
      }
      isOpen = true;
      element.hidden = false;
      input.focus();
      input.select();
      // Прежний запрос мог остаться — ищем заново: лента с тех пор изменилась.
      if (input.value.length > 0) search();
    },
    close,
    get isOpen() {
      return isOpen;
    },
    refresh,
  };
}
