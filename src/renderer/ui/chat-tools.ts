import type { ChatToolResultPayload, ChatToolStartPayload } from '../../shared/api';
import { highlightInto } from '../core/highlight';
import { languageFromPath } from '../core/languages';
import { basename, h, svgIcon, type IconName } from './dom';

/**
 * Карточки вызовов инструментов в ленте чата.
 *
 * Вынесено из `chat.ts`, чтобы панель занималась разговором, а не разметкой
 * карточек: подряд идущие вызовы собираются в одну сворачиваемую группу,
 * иначе агент за шаг заливает ленту десятком строк.
 */

const TOOL_LABELS: Record<string, string> = {
  list_dir: 'Просмотр папки',
  read_file: 'Чтение файла',
  search: 'Поиск по проекту',
  get_diagnostics: 'Диагностика',
  apply_edit: 'Правка файлов',
  run_terminal: 'Команда в терминале',
  create_file: 'Создание файла',
  delete_file: 'Удаление',
  move_file: 'Перемещение',
  update_plan: 'План',
  git_status: 'Состояние git',
  git_diff: 'Diff git',
  open_file: 'Открытие файла',
  terminal_list: 'Список терминалов',
  terminal_start: 'Запуск в терминале',
  terminal_read: 'Чтение терминала',
  terminal_write: 'Ввод в терминал',
  terminal_stop: 'Остановка терминала',
};

/** У инструмента свой значок: строка читается без чтения подписи. */
const TOOL_ICONS: Record<string, IconName> = {
  list_dir: 'folder',
  read_file: 'file',
  search: 'search',
  get_diagnostics: 'warning',
  apply_edit: 'wrench',
  run_terminal: 'terminal',
  create_file: 'filePlus',
  delete_file: 'trash',
  move_file: 'file',
  update_plan: 'command',
  git_status: 'branch',
  git_diff: 'branch',
  open_file: 'file',
  terminal_list: 'terminal',
  terminal_start: 'terminal',
  terminal_read: 'terminal',
  terminal_write: 'terminal',
  terminal_stop: 'terminal',
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

function toolIcon(name: string): IconName {
  return TOOL_ICONS[name] ?? 'wrench';
}

/** Аргументы вызова в одну строку: путь, запрос, маска. */
function summarizeArgs(raw: string): string {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof value.path === 'string') parts.push(value.path);
    if (typeof value.from === 'string' && typeof value.to === 'string') parts.push(`${value.from} → ${value.to}`);
    if (typeof value.query === 'string') parts.push(`«${value.query}»`);
    if (typeof value.glob === 'string') parts.push(value.glob);
    if (typeof value.command === 'string') parts.push(value.command);
    if (typeof value.id === 'string') parts.push(value.id);
    if (typeof value.data === 'string') parts.push(`«${value.data.replace(/\n/g, '⏎').slice(0, 40)}»`);
    if (Array.isArray(value.steps)) parts.push(`${value.steps.length} шагов`);
    // apply_edit: в карточке нужны имена файлов, а не сырой JSON на 80 символов.
    if (Array.isArray(value.edits)) {
      for (const file of value.edits) {
        if (file && typeof file === 'object' && typeof (file as { path?: unknown }).path === 'string') {
          parts.push(basename((file as { path: string }).path));
        }
      }
    }
    if (parts.length === 0) parts.push(raw.trim().slice(0, 80));
    return parts.join(' · ');
  } catch {
    return raw.trim().slice(0, 80);
  }
}

/** Строка вызова инструмента и её обновление — в одном месте. */
export interface ToolCardView {
  card: HTMLElement;
  finish(result: ChatToolResultPayload): void;
}

/**
 * Язык для подсветки вывода инструмента. Вывод — это код: содержимое файла
 * или команда, и он заслуживает той же подсветки, что блоки в ответе.
 */
function toolDetailLanguage(call: ChatToolStartPayload): string {
  if (call.name === 'run_terminal') return 'shell';
  if (call.name !== 'read_file' && call.name !== 'list_dir') return '';
  try {
    const args = JSON.parse(call.args) as { path?: unknown };
    return typeof args.path === 'string' ? languageFromPath(args.path) : '';
  } catch {
    return ''; // аргументы не разобрались — покажем текстом, это не ошибка
  }
}

/** Состояние строки вызова: пока идёт — «выполняется…», потом итог. */
function toolStateElement(): HTMLElement {
  return h('span', { class: 'tool-state' }, 'выполняется…');
}

function setToolState(element: HTMLElement, ok: boolean): void {
  element.textContent = ok ? 'готово' : 'ошибка';
  element.classList.toggle('is-fail', !ok);
}

/** Одна группа вызовов: шапка со сводкой и строки под раскрытием. */
interface ToolGroupView {
  add(call: ChatToolStartPayload): ToolCardView;
  seal(): void;
}

function createToolGroup(container: HTMLElement): ToolGroupView {
  let count = 0;
  let pending = 0;
  let failed = 0;
  /** Раскрыта ли группа руками: тогда автоматика её не сворачивает. */
  let pinned = false;
  let expanded = true;
  const names: string[] = [];

  const title = h('span', { class: 'tool-group-title' }, 'Действия');
  const tools = h('span', { class: 'tool-group-tools' });
  const state = h('span', { class: 'tool-group-state' }, 'выполняется…');
  const body = h('div', { class: 'tool-group-body' });
  const chevron = svgIcon('chevronDown', 12);
  chevron.classList.add('tool-chevron');

  const applyExpanded = (): void => {
    body.hidden = !expanded;
    root.classList.toggle('is-open', expanded);
  };

  const head = h(
    'button',
    {
      class: 'tool-group-head',
      type: 'button',
      'aria-expanded': 'true',
      onClick: () => {
        expanded = !expanded;
        pinned = true;
        head.setAttribute('aria-expanded', String(expanded));
        applyExpanded();
      },
    },
    svgIcon('wrench', 13),
    title,
    tools,
    state,
    chevron,
  );

  const root = h('div', { class: 'tool-group is-open' }, head, body);
  container.appendChild(root);

  const sync = (): void => {
    title.textContent = `Действия · ${count}`;
    const brief = names.slice(0, 2).join(', ');
    tools.textContent = names.length > 2 ? `${brief} и ещё ${names.length - 2}` : brief;

    if (pending > 0) {
      state.textContent = 'выполняется…';
      state.className = 'tool-group-state';
      return;
    }

    state.textContent = failed > 0 ? `ошибок: ${failed}` : 'готово';
    state.className = `tool-group-state${failed > 0 ? ' is-fail' : ' is-ok'}`;
    // Работа закончилась — держать список перед глазами больше незачем.
    if (!pinned) {
      expanded = false;
      applyExpanded();
    }
  };

  const add = (call: ChatToolStartPayload): ToolCardView => {
    count += 1;
    pending += 1;
    const label = toolLabel(call.name);
    if (!names.includes(label)) names.push(label);

    const cardState = toolStateElement();
    const panel = h('div', { class: 'tool-panel', hidden: true });
    const card = h('div', { class: 'tool-card' });
    const rowChevron = svgIcon('chevronDown', 12);
    rowChevron.classList.add('tool-chevron');

    let outcome: ChatToolResultPayload | null = null;
    const detailLanguage = toolDetailLanguage(call);

    /** Подробности собираем по первому запросу: до ответа инструмента их нет. */
    const togglePanel = (): void => {
      if (!outcome) return;
      if (panel.childElementCount === 0) {
        panel.appendChild(h('div', { class: 'tool-summary' }, outcome.summary));
        if (outcome.detail) {
          const raw = h('code', {});
          highlightInto(raw, outcome.detail, detailLanguage);
          panel.appendChild(h('pre', { class: 'tool-raw' }, raw));
        }
      }
      panel.hidden = !panel.hidden;
      card.classList.toggle('is-open', !panel.hidden);
    };

    card.append(
      h(
        'button',
        {
          class: 'tool-head',
          type: 'button',
          title: `${label} — показать вывод`,
          onClick: togglePanel,
        },
        svgIcon(toolIcon(call.name), 13),
        h('span', { class: 'tool-name' }, label),
        h('span', { class: 'tool-args' }, summarizeArgs(call.args)),
        cardState,
        rowChevron,
      ),
      panel,
    );
    body.appendChild(card);
    sync();

    return {
      card,
      finish: (result) => {
        outcome = result;
        setToolState(cardState, result.ok);
        card.classList.toggle('tool-failed', !result.ok);
        pending -= 1;
        if (!result.ok) failed += 1;
        sync();
      },
    };
  };

  /**
   * Закрываем группу: дальше идёт текст ответа или новый вопрос.
   * Одиночный вызов группы не требует — он остаётся обычной строкой.
   * Сама группа при этом жива: её шапка по-прежнему раскрывает строки.
   */
  const seal = (): void => {
    if (count === 1) {
      const solo = body.firstElementChild as HTMLElement | null;
      if (solo) root.replaceWith(solo);
      return;
    }
    if (pending === 0 && !pinned) {
      expanded = false;
      applyExpanded();
    }
  };

  return { add, seal };
}

/**
 * Лента вызовов инструментов.
 *
 * Агент за один шаг читает десяток файлов, и строка на каждый вызов
 * превращает чат в свалку. Поэтому подряд идущие вызовы собираются в одну
 * группу: в ленте остаётся её шапка («Действия · 6 · Просмотр папки,
 * Чтение файла · готово»), а сами строки — под раскрытием.
 */
export function createToolFeed(container: HTMLElement): {
  add(call: ChatToolStartPayload): ToolCardView;
  seal(): void;
} {
  let current: ToolGroupView | null = null;

  return {
    add: (call) => {
      current ??= createToolGroup(container);
      return current.add(call);
    },
    seal: () => {
      current?.seal();
      current = null;
    },
  };
}
