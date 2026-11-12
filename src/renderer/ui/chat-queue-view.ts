/**
 * Вид очереди отложенных вопросов в ленте чата.
 *
 * Данные очереди лежат в `chat-queue.ts` и там намеренно нет DOM. Здесь —
 * только отрисовка и кнопки, поэтому зависимость от `h` и от ленты не течёт
 * в тот модуль.
 */
import type { ChatSession } from './chat-session';
import { h } from './dom';
import { clearQueuedPrompts, dropQueuedPrompt, moveQueuedPrompt } from './chat-queue';

export interface ChatQueueViewDeps {
  /** Открытая беседа: только у неё поле ввода живо и нужна протяжка вниз. */
  activeId: () => number;
  /** Перерисовать чипы вложений: снятый вопрос возвращает их в поле. */
  renderAttachments: () => void;
  scrollToEnd: (session: ChatSession) => void;
}

export interface ChatQueueView {
  renderQueue: (session: ChatSession) => void;
  /** Снять отложенный вопрос; при снятии из открытой беседы вернуть вложения. */
  dropQueued: (session: ChatSession, index: number) => void;
  /** Переставить в очереди; фокус остаётся на той же кнопке. */
  moveQueued: (session: ChatSession, index: number, delta: number) => void;
  /** Очистить очередь и обновить чипы вложений. */
  clearQueue: (session: ChatSession) => void;
}

export function createChatQueueView(deps: ChatQueueViewDeps): ChatQueueView {
  const { activeId, renderAttachments, scrollToEnd } = deps;

  /**
   * Очередь вопросов в ленте, в самом низу.
   *
   * Рисуем отдельно от истории и перерисовываем целиком при каждом изменении: так
   * проще всего не расходиться с `session.queue`, а строк в ней мало (человек
   * пишет во время ответа несколько, а не сотни).
   */
  function renderQueue(session: ChatSession): void {
    session.queueNode?.remove();
    session.queueNode = undefined;
    const queued = session.queue ?? [];
    if (queued.length === 0) return;
    const list = h('ol', { class: 'queue-list' });
    queued.forEach((item, index) => {
      const text = item.text.length > 120 ? `${item.text.slice(0, 119)}…` : item.text;
      list.appendChild(
        h(
          'li',
          { class: 'queue-item' },
          h('span', { class: 'queue-index' }, String(index + 1)),
          h('span', { class: 'queue-text' }, text),
          h('button', {
            class: 'queue-move',
            type: 'button',
            title: 'Выше',
            'aria-label': `Переставить вопрос ${index + 1} выше`,
            // Край серый, а не спрятан: пропавшая кнопка ломает навигацию с экрана,
            // а серая говорит, что ход есть, но отсюда нельзя.
            disabled: index === 0,
            'aria-disabled': String(index === 0),
            onClick: () => moveQueued(session, index, -1),
          }),
          h('button', {
            class: 'queue-move',
            type: 'button',
            title: 'Ниже',
            'aria-label': `Переставить вопрос ${index + 1} ниже`,
            disabled: index === queued.length - 1,
            'aria-disabled': String(index === queued.length - 1),
            onClick: () => moveQueued(session, index, 1),
          }),
          h('button', {
            class: 'queue-drop',
            type: 'button',
            title: 'Снять с очереди',
            'aria-label': `Снять с очереди вопрос ${index + 1}`,
            onClick: () => dropQueued(session, index),
          }),
        ),
      );
    });
    session.queueNode = h(
      'div',
      { class: 'chat-queue' },
      h(
        'div',
        { class: 'chat-queue-head' },
        `В очереди: ${queued.length}`,
        h('button', { class: 'chat-queue-clear', type: 'button', onClick: () => clearQueue(session) }, 'Снять все'),
      ),
      list,
    );
    session.thread.appendChild(session.queueNode);
    // Лента скроллится снаружи: очередь дописана снизу, и без протяжки её не видно.
    if (session.id === activeId()) scrollToEnd(session);
  }

  /** Убрать один отложенный вопрос: вложения возвращаются в поле, чтобы не пропали. */
  function dropQueued(session: ChatSession, index: number): void {
    // Вложения возвращаются всегда, а поле чипов показывает только открытая беседа —
    // закрытой они не нужны, и перерисовка не вредит.
    if (dropQueuedPrompt(session, index) && session.id === activeId()) renderAttachments();
    renderQueue(session);
  }

  /**
   * Переставить отложенный вопрос и вернуть фокус на ту же кнопку.
   *
   * `renderQueue` перерисовывает список целиком, поэтому головы строки после
   * перестановки уже нет в документе — фокус упал бы в `body` (в начало ленты для
   * того, кто идёт с клавиатуры). Поэтому ищем новую строку по номеру и ставим
   * фокус на кнопку того же направления.
   *
   * `scrollToEnd` тут не нужен (и `renderQueue` его зовёт только для активной
   * беседы): порядок в ЛЕНТЕ не изменился, двигается только очередь.
   */
  function moveQueued(session: ChatSession, index: number, delta: number): void {
    if (!moveQueuedPrompt(session, index, delta)) return;
    renderQueue(session);
    const node = session.queueNode;
    if (!node || session.id !== activeId()) return;
    const row = node.querySelectorAll('.queue-item')[index + delta];
    const button = row?.querySelectorAll('.queue-move')[delta < 0 ? 0 : 1];
    (button as HTMLElement | undefined)?.focus({ preventScroll: true });
  }

  function clearQueue(session: ChatSession): void {
    if (clearQueuedPrompts(session) && session.id === activeId()) renderAttachments();
    renderQueue(session);
  }

  return { renderQueue, dropQueued, moveQueued, clearQueue };
}
