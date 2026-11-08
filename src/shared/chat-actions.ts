/**
 * Свои команды беседы — те, что управляют самим разговором, а не уходят
 * вопросом к модели.
 *
 * Отдельным модулем, без DOM: это чистый разбор строки, и проверять его надо
 * тестами, а не глазами в композере. Команды проекта (`/имя` из `.chui_ide`)
 * живут рядом и в том же синтаксисе, но делают другое: подставляют свой текст в
 * вопрос. Здесь же — действие.
 */
export type ChatActionId = 'compact' | 'new' | 'fork' | 'compare';

export interface ChatAction {
  id: ChatActionId;
  /** Слово в композере — вместе со слешем. */
  command: string;
  title: string;
  hint: string;
}

export const CHAT_ACTIONS: readonly ChatAction[] = [
  {
    id: 'compact',
    command: '/compact',
    title: 'Сжать контекст',
    hint: 'пересказать переписку резюме и сказать, что в него вошло',
  },
  {
    id: 'new',
    command: '/new',
    title: 'Новая беседа',
    hint: 'текущая остаётся во вкладке',
  },
  {
    id: 'fork',
    command: '/fork',
    title: 'Ветка беседы',
    hint: 'копия переписки в новой вкладке; можно дать имя: /fork про кеш',
  },
  {
    id: 'compare',
    command: '/compare',
    title: 'Сравнить ветки',
    hint: 'показать, до какого места две беседы совпадают и чем расходятся',
  },
];

export interface ParsedChatAction {
  action: ChatAction;
  /** Хвост после команды: у `/fork` — имя ветки. Может быть пустым. */
  argument: string;
}

/**
 * Распознать свою команду в набранном тексте.
 *
 * Имя сравнивается целиком и только у первого слова: `/newbie` — это не `/new`,
 * а обычный вопрос. Без этого человек, начавший вопрос со слеша, терял бы текст.
 */
export function parseChatAction(text: string): ParsedChatAction | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const space = trimmed.search(/\s/);
  const word = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const action = CHAT_ACTIONS.find((item) => item.command === word);
  if (!action) return null;
  return { action, argument: space === -1 ? '' : trimmed.slice(space).trim() };
}
