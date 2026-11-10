import { h } from './dom';
import { createModal } from './modal';
import { compareForks } from './chat-fork';
import type { ChatMessage } from '../../shared/api';

/**
 * Панель сравнения двух веток беседы.
 *
 * Ветка — это копия беседы в отдельной вкладке; после второй-третьей копии
 * человек уже не помнит, чем они отличаются. Панель отвечает на один вопрос:
 * до какого места они одинаковы и чем расходятся.
 */
export interface ForkCompareTarget {
  readonly title: string;
  readonly transcript: readonly ChatMessage[];
}

export interface ForkCompareDeps {
  /** Все беседы с их транскриптами: из них выбирают пару для сравнения. */
  sessions(): readonly ForkCompareTarget[];
  /** Открыть беседу по названию — чтобы сразу перейти и продолжить. */
  open(title: string): void;
}

/** Коротко о сообщении: что это и о чём. */
function messageLine(message: ChatMessage): string {
  const role = message.role === 'user' ? 'Вы' : message.role === 'assistant' ? 'Ассистент' : message.role;
  const text = (message.content ?? '').replace(/\s+/g, ' ').trim();
  const short = text.length > 120 ? `${text.slice(0, 117)}…` : text;
  return `${role}: ${short === '' ? '(пусто)' : short}`;
}

/** Одна колонка ветки: список сообщений после расхождения. */
function column(branch: ForkCompareTarget, messages: readonly ChatMessage[], shared: number): HTMLElement {
  const head = h('h3', { class: 'fork-compare-head' }, branch.title);
  const note = h(
    'div',
    { class: 'fork-compare-note' },
    messages.length === 0
      ? 'Продолжения нет — ветка заканчивается на общем месте'
      : `Своих сообщений: ${messages.length}`,
  );
  const list = h('ol', { class: 'fork-compare-list' });
  for (const message of messages) {
    list.appendChild(h('li', { class: `fork-compare-msg is-${message.role}` }, messageLine(message)));
  }
  return h(
    'div',
    { class: 'fork-compare-column' },
    head,
    note,
    h('div', { class: 'fork-compare-sep' }, `Общих сообщений до расхождения: ${shared}`),
    list,
  );
}

export function showForkCompare(deps: ForkCompareDeps, leftTitle?: string): void {
  const all = deps.sessions();
  if (all.length < 2) {
    // Сравнивать нечего: веток меньше двух. Говорим об этом, а не показываем пустоту.
    return;
  }
  const left = all.find((item) => item.title === leftTitle) ?? all[0]!;
  const right = all.find((item) => item !== left) ?? all[1]!;

  const result = compareForks(left.transcript, right.transcript);
  const body = h(
    'div',
    { class: 'fork-compare' },
    h(
      'div',
      { class: 'fork-compare-summary' },
      result.shared === 0 ? 'Ветки расходятся с первого сообщения' : `Первые ${result.shared} сообщений совпадают`,
    ),
    h(
      'div',
      { class: 'fork-compare-columns' },
      column(left, result.left, result.shared),
      column(right, result.right, result.shared),
    ),
  );

  const openLeft = h('button', { class: 'modal-btn', type: 'button' }, `Открыть «${left.title}»`);
  const openRight = h('button', { class: 'modal-btn', type: 'button' }, `Открыть «${right.title}»`);
  const modal = createModal({
    className: 'fork-compare-modal',
    title: 'Сравнение веток',
    footer: h('footer', { class: 'modal-footer is-end' }, openLeft, openRight),
  });
  openLeft.addEventListener('click', () => {
    modal.close();
    deps.open(left.title);
  });
  openRight.addEventListener('click', () => {
    modal.close();
    deps.open(right.title);
  });
  modal.body.append(body);
}
