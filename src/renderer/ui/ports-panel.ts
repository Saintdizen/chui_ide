/**
 * Вкладка «Порты»: что слушает на машине и что из этого открыли наши терминалы.
 *
 * Почему не автопроброс: пробрасывать некуда — редактор и терминал живут на
 * одной машине. Ценность в другом: увидеть порт, который поднял твой процесс,
 * и открыть его одним кликом, а не копировать номер из вывода `npm run dev`.
 *
 * Опрос — своим таймером и только пока вкладка видима: `lsof` на большой машине
 * не бесплатен, а держать панель в актуальном виде за глаза от человека незачем.
 */
import type { PortEntry } from '../../shared/port-forward';
import { clear, h } from './dom';
import { errorText } from '../core/file-errors';

/** Между опросами: чаще — лишние процессы, реже — порт появляется с задержкой. */
const POLL_MS = 2500;

export interface PortsPanelDeps {
  /** Список портов у main (см. `PortService.list`). */
  list(): Promise<PortEntry[]>;
  /** Открыть адрес внешней программой: схема проверяется в main. */
  open(url: string): void;
  /** Показать терминал: откуда взялся порт — половина ответа. */
  revealTerminal(): void;
}

export interface PortsPanel {
  element: HTMLElement;
  /** Вкладка показана: начинаем опрос. */
  open(): void;
  /** Вкладка скрыта: таймер останавливаем, иначе опрос живёт за глазами. */
  close(): void;
  refresh(): Promise<void>;
}

export function createPortsPanel(deps: PortsPanelDeps): PortsPanel {
  const list = h('div', { class: 'ports-list' });
  const status = h('div', { class: 'ports-status' });
  const element = h(
    'div',
    { class: 'ports-panel' },
    h('div', { class: 'ports-header' }, h('span', {}, 'Слушающие порты'), status),
    list,
  );

  let timer: ReturnType<typeof setInterval> | null = null;
  // Ответы могут приходить не по порядку (`lsof` иногда думает дольше):
  // рисуем только последний, иначе список дёргается между двумя снимками.
  let generation = 0;
  let shown: PortEntry[] = [];
  let failed: string | null = null;

  function renderRow(item: PortEntry): HTMLElement {
    const actions = h('div', { class: 'ports-actions' });
    const open = h('button', { class: 'ports-open', type: 'button' }, 'Открыть');
    open.title = item.url;
    open.addEventListener('click', () => deps.open(item.url));
    actions.appendChild(open);
    if (item.terminalId) {
      // Терминал — часть ответа «чей это порт»: гасить id бесполезно, его надо открыть.
      const reveal = h('button', { class: 'ports-reveal', type: 'button' }, 'Терминал');
      reveal.addEventListener('click', () => deps.revealTerminal());
      actions.appendChild(reveal);
    }

    const owner = item.terminalId ? 'из терминала' : 'чужой процесс';
    return h(
      'div',
      { class: `ports-row${item.terminalId ? ' is-ours' : ''}` },
      h('span', { class: 'ports-port' }, String(item.port)),
      h('span', { class: 'ports-command', title: item.command }, item.command || '—'),
      h('span', { class: 'ports-owner' }, owner),
      actions,
    );
  }

  function render(): void {
    clear(list);
    if (shown.length === 0) {
      list.appendChild(
        h(
          'div',
          { class: 'ports-empty' },
          failed
            ? `Список не получен: ${failed}`
            : 'Ничего не слушает. Запустите сервер в терминале — порт появится здесь.',
        ),
      );
      return;
    }
    for (const item of shown) list.appendChild(renderRow(item));
  }

  async function refresh(): Promise<void> {
    const mine = ++generation;
    try {
      const next = await deps.list();
      if (mine !== generation) return;
      shown = next;
      failed = null;
    } catch (error) {
      if (mine !== generation) return;
      // Пустой список и сломанный опрос — разные вещи: второй может сбить
      // человека на мысль, что сервер не запустился.
      failed = errorText(error);
    }
    status.textContent = shown.length > 0 ? `${shown.length}` : '';
    render();
  }

  render();

  return {
    element,
    open(): void {
      if (timer !== null) return;
      void refresh();
      timer = setInterval(() => void refresh(), POLL_MS);
    },
    close(): void {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
    refresh,
  };
}
