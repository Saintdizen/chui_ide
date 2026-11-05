import type { LspTraceLine } from '../../shared/lsp-trace';
import { h } from './dom';

/**
 * Панель «LSP» в доке: хвост журнала обмена с языковыми серверами.
 *
 * Зачем панель, если журнал и так пишется в файл: человек, у которого сервер
 * молчит, не пойдёт искать файл в пользовательских данных — он смотрит туда же,
 * где привык видеть вывод инструментов. Панель показывает конец журнала и прямо
 * говорит, что журнал выключен, а не притворяется пустым.
 */
export interface LspLogPanel {
  element: HTMLElement;
  refresh(): Promise<void>;
}

export interface LspLogDeps {
  fetch: (lines: number) => Promise<{ enabled: boolean; path: string | null; lines: LspTraceLine[] }>;
  openSettings: () => void;
  /** Сколько строк просим у main. */
  lines?: number;
}

export function createLspLogPanel(deps: LspLogDeps): LspLogPanel {
  const hint = h('div', { class: 'lsp-log-hint', hidden: true });
  // Фильтр по тексту: и по серверу, и по методу. Журнал длинный, и искать в нём
  // глазами — то же, что не читать вовсе.
  const filter = h('input', { class: 'lsp-log-filter', type: 'search', placeholder: 'Фильтр: сервер или метод' });
  let all: LspTraceLine[] = [];
  filter.addEventListener('input', () => draw());
  const body = h('div', { class: 'lsp-log-body' });
  const refreshButton = h('button', { class: 'btn btn-small', type: 'button' }, 'Обновить');
  const settingsButton = h('button', { class: 'btn btn-small', type: 'button' }, 'Настройки языков');
  const element = h(
    'div',
    { class: 'lsp-log' },
    h('div', { class: 'lsp-log-actions' }, refreshButton, settingsButton, filter),
    hint,
    body,
  );

  settingsButton.addEventListener('click', () => deps.openSettings());
  refreshButton.addEventListener('click', () => void refresh());

  async function refresh(): Promise<void> {
    refreshButton.disabled = true;
    try {
      const result = await deps.fetch(deps.lines ?? 300);
      render(result);
    } catch (error) {
      showHint(error instanceof Error ? error.message : String(error));
    } finally {
      refreshButton.disabled = false;
    }
  }

  function render(result: { enabled: boolean; path: string | null; lines: LspTraceLine[] }): void {
    body.replaceChildren();
    if (!result.enabled) {
      showHint('Журнал выключен: включите «lsp.trace», чтобы видеть обмен с серверами.');
      return;
    }
    if (result.lines.length === 0) {
      showHint(
        result.path
          ? 'Журнал пуст: серверы ещё не обменивались сообщениями с момента включения.'
          : 'Журнал не настроен.',
      );
      return;
    }
    hint.hidden = true;
    all = result.lines;
    draw();
  }

  /** Перерисовать с учётом фильтра: он не меняет то, что пришло от main. */
  function draw(): void {
    const needle = filter.value.trim().toLowerCase();
    const visible = needle
      ? all.filter((line) => `${line.server} ${line.kind} ${line.text}`.toLowerCase().includes(needle))
      : all;
    hint.hidden = true;
    if (visible.length === 0) {
      showHint(`Под фильтр «${filter.value.trim()}» ничего не подошло.`);
      return;
    }
    body.replaceChildren(...visible.map(renderLine));
    body.scrollTop = body.scrollHeight;
  }

  function showHint(text: string): void {
    body.replaceChildren();
    hint.hidden = false;
    hint.textContent = text;
  }

  return { element, refresh };
}

/** Строка журнала: время, направление и метод; текст — в подсказке. */
function renderLine(line: LspTraceLine): HTMLElement {
  const at = line.at ? new Date(line.at) : null;
  const time = at && !Number.isNaN(at.getTime()) ? at.toLocaleTimeString() : '';
  return h(
    'div',
    { class: `lsp-log-line is-${line.direction}`, title: line.text },
    h('span', { class: 'lsp-log-time' }, time),
    h('span', { class: 'lsp-log-direction' }, line.direction === 'server' ? '←' : '→'),
    h('span', { class: 'lsp-log-server' }, line.server),
    h('span', { class: 'lsp-log-kind' }, line.kind),
  );
}
