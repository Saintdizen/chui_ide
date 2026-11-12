/**
 * `Alt+↑/↓` — переход по сообщениям в ленте.
 *
 * Вынесено из `chat.ts`: здесь нет ни стрима, ни RPC — только курсор по ленте.
 * Курсор живёт в замыкании фабрики: он состояние этого перехода, а не беседы.
 */
import { promptNeighbour } from '../../shared/chat-nav';
import type { ChatSession } from './chat-session';

export interface ChatPromptNavDeps {
  /** Беседа, по которой сейчас ходим. */
  active: () => ChatSession;
}

export interface ChatPromptNav {
  jumpToPrompt: (delta: number) => void;
  /** Лента перерисовалась — индекс уже врёт. */
  reset: () => void;
}

export function createChatPromptNav(deps: ChatPromptNavDeps): ChatPromptNav {
  const { active } = deps;

  let promptCursor = -1;

  const reset = (): void => {
    promptCursor = -1;
  };

  function jumpToPrompt(delta: number): void {
    const session = active();
    const nodes = [...session.thread.querySelectorAll<HTMLElement>('.msg')];
    if (nodes.length === 0) return;
    const roles = nodes.map((node) => ({ role: node.classList.contains('msg-user') ? 'user' : 'assistant' }));

    // Курсор мог остаться от прошлой ленты (беседа перерисована) — тогда его
    // нет: `promptNeighbour` сам начнёт с края в нужную сторону.
    const from = promptCursor >= 0 && promptCursor < nodes.length ? promptCursor : -1;
    const target = promptNeighbour(roles, from, delta);
    if (target < 0) return;

    promptCursor = target;
    const node = nodes[target]!;
    node.scrollIntoView({ block: 'start', behavior: 'auto' });
    for (const other of session.thread.querySelectorAll('.is-prompt-current')) {
      other.classList.remove('is-prompt-current');
    }
    node.classList.add('is-prompt-current');

    // Проговорить для скринридера: обводка — единственный признак, что прыжок
    // состоялся, а её не видят.
    const index = roles.slice(0, target + 1).filter((message) => message.role === 'user').length;
    const total = roles.filter((message) => message.role === 'user').length;
    node.setAttribute('aria-label', `Вопрос ${index} из ${total}`);
  }

  return { jumpToPrompt, reset };
}
