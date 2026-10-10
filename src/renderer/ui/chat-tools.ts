import type { ChatToolResultPayload, ChatToolStartPayload } from '../../shared/api';
import { touchedFiles } from '../../shared/tool-files';
import { highlightInto } from '../core/highlight';
import { languageFromPath } from '../core/languages';
import { fileWord, plural } from './chat-text';
import { basename, h, svgIcon, type IconName } from './dom';
import { fileIcon } from './file-icons';

/**
 * Карточки вызовов инструментов в ленте чата.
 *
 * Вынесено из `chat.ts`, чтобы панель занималась разговором, а не разметкой
 * карточек: подряд идущие вызовы собираются в одну сворачиваемую группу,
 * иначе агент за шаг заливает ленту десятком строк.
 */

/** Размышления показываются целиком, но без предела одна строка съест ленту. */
const MAX_REASONING_CHARS = 20_000;

const TOOL_LABELS: Record<string, string> = {
  list_dir: 'Просмотр папки',
  read_file: 'Чтение файла',
  read_files: 'Чтение файлов',
  search: 'Поиск по проекту',
  project_map: 'Карта проекта',
  file_outline: 'Скелет файла',
  find_files: 'Поиск файлов',
  get_diagnostics: 'Диагностика',
  apply_edit: 'Правка файлов',
  replace_in_files: 'Замена по проекту',
  run_terminal: 'Команда в терминале',
  create_file: 'Создание файла',
  delete_file: 'Удаление',
  move_file: 'Перемещение',
  update_plan: 'План',
  git_status: 'Состояние git',
  git_diff: 'Diff git',
  git_log: 'История git',
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
  read_files: 'file',
  search: 'search',
  project_map: 'panel',
  file_outline: 'checklist',
  find_files: 'folder',
  get_diagnostics: 'warning',
  apply_edit: 'wrench',
  replace_in_files: 'refresh',
  run_terminal: 'terminal',
  create_file: 'filePlus',
  delete_file: 'trash',
  move_file: 'file',
  update_plan: 'command',
  git_status: 'branch',
  git_diff: 'branch',
  git_log: 'command',
  open_file: 'file',
  terminal_list: 'terminal',
  terminal_start: 'terminal',
  terminal_read: 'terminal',
  terminal_write: 'terminal',
  terminal_stop: 'terminal',
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

function toolIcon(name: string): IconName {
  return TOOL_ICONS[name] ?? 'wrench';
}

/** Путь файла, если инструмент работает явно с одним файлом; иначе null. */
function toolFilePath(name: string, raw: string): string | null {
  if (name === 'list_dir') return null; // каталог, а не файл
  try {
    const value = JSON.parse(raw) as { path?: unknown; edits?: unknown };
    if (typeof value.path === 'string' && value.path) return value.path;
    if (Array.isArray(value.edits)) {
      const paths = value.edits
        .map((file) => (file && typeof file === 'object' ? (file as { path?: unknown }).path : undefined))
        .filter((path): path is string => typeof path === 'string' && !!path);
      if (new Set(paths).size === 1) return paths[0] ?? null;
    }
  } catch {
    // не JSON — остаётся общая иконка инструмента
  }
  return null;
}

/** Иконка карточки инструмента: у файловых операций — цветной значок типа файла. */
function toolIconNode(name: string, raw: string): SVGSVGElement {
  const path = toolFilePath(name, raw);
  return path ? fileIcon(path, 13) : svgIcon(toolIcon(name), 13);
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
    // Вызов без аргументов (`project_map`) — пустая подпись: `{}` в строке
    // читалось бы как сломанный аргумент, а не как «инструменту ничего не нужно».
    if (parts.length === 0 && raw.trim() !== '{}') parts.push(raw.trim().slice(0, 80));
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

/** Состояние строки вызова: пока идёт — «выполняется» (класс даёт пульсацию), потом итог. */
function toolStateElement(): HTMLElement {
  return h('span', { class: 'tool-state is-running' }, 'выполняется');
}

function setToolState(element: HTMLElement, ok: boolean): void {
  element.textContent = ok ? 'готово' : 'ошибка';
  element.classList.toggle('is-ok', ok);
  element.classList.toggle('is-fail', !ok);
  element.classList.remove('is-running');
}

/** Размышления — сворачиваемая строка внутри группы действий. */
export interface ReasoningRowView {
  /** Добавить фрагмент текущей части размышлений. */
  push(chunk: string): void;
  /** Начать новую часть: следующая врезка станет отдельным абзацем. */
  part(): void;
  /** Свернуть строку — ответ начался или закончился. */
  collapse(): void;
}

/** Одна группа вызовов: шапка со сводкой и строки под раскрытием. */
interface ToolGroupView {
  add(call: ChatToolStartPayload): ToolCardView;
  reasoning(): ReasoningRowView;
  seal(): void;
}

function createToolGroup(container: HTMLElement, anchor: Node | null, onUpdate?: () => void): ToolGroupView {
  let count = 0;
  let pending = 0;
  let failed = 0;
  /** Сколько файлов тронули вызовы группы: видно в сводке, когда группа свёрнута. */
  let changedFiles = 0;
  /** Раскрыта ли группа. Меняет только человек: само состояние не трогаем. */
  let expanded = true;
  const names: string[] = [];

  const title = h('span', { class: 'tool-group-title' }, 'Действия');
  const tools = h('span', { class: 'tool-group-tools' });
  const state = h('span', { class: 'tool-group-state is-running' }, 'выполняется');
  const body = h('div', { class: 'tool-group-body' });
  const chevron = svgIcon('chevronDown', 12);
  chevron.classList.add('tool-chevron');

  // ── размышления модели ───────────────────────────────────────
  // Размышления — такая же строка ленты, как и вызов инструмента: узел со
  // значком на рельсе, подпись и раскрываемый текст. Держим их ОДНОЙ строкой
  // на группу: шагов у агента много, но для человека это одно «думание» —
  // части копим в списке, разделяем пустой строкой и считаем счётчиком.
  let reasoningCard: HTMLElement | null = null;
  let reasoningPanel: HTMLElement | null = null;
  let reasoningText: HTMLElement | null = null;
  let reasoningCount: HTMLElement | null = null;
  const reasoningParts: string[] = [];
  /** Открыта ли текущая часть: следующая врезка начнёт новую (см. part). */
  let reasoningOpen = false;
  let reasoningFrame = 0;

  const flushReasoning = (): void => {
    if (reasoningText) reasoningText.textContent = reasoningParts.join('\n\n');
    if (reasoningCount) reasoningCount.textContent = reasoningParts.length > 1 ? String(reasoningParts.length) : '';
  };

  /** Строка заводится по первому фрагменту и садится первой в ленте: думание — до действий. */
  const ensureReasoning = (): void => {
    if (reasoningCard) return;
    reasoningText = h('div', { class: 'reasoning-text' });
    reasoningCount = h('span', { class: 'reasoning-count' });
    reasoningPanel = h('div', { class: 'tool-panel', hidden: true }, reasoningText);
    const rowChevron = svgIcon('chevronDown', 12);
    rowChevron.classList.add('tool-chevron');
    const card = h(
      'div',
      { class: 'tool-card' },
      h(
        'button',
        {
          class: 'tool-head',
          type: 'button',
          title: 'Размышления — показать',
          onClick: () => {
            if (!reasoningPanel) return;
            reasoningPanel.hidden = !reasoningPanel.hidden;
            card.classList.toggle('is-open', !reasoningPanel.hidden);
          },
        },
        svgIcon('bulb', 13),
        h('span', { class: 'tool-name' }, 'Размышления'),
        reasoningCount,
        h('span', { class: 'tool-args' }),
        rowChevron,
      ),
      reasoningPanel,
    );
    reasoningCard = card;
    body.prepend(card);
  };

  const reasoning: ReasoningRowView = {
    push: (chunk) => {
      ensureReasoning();
      if (!reasoningOpen) {
        reasoningParts.push('');
        reasoningOpen = true;
      }
      const index = reasoningParts.length - 1;
      const current = reasoningParts[index] ?? '';
      if (current.length + chunk.length <= MAX_REASONING_CHARS) reasoningParts[index] = current + chunk;
      if (reasoningFrame) return;
      reasoningFrame = requestAnimationFrame(() => {
        reasoningFrame = 0;
        flushReasoning();
        onUpdate?.();
      });
    },
    part: () => {
      reasoningOpen = false;
    },
    collapse: () => {
      if (reasoningFrame) cancelAnimationFrame(reasoningFrame);
      reasoningFrame = 0;
      flushReasoning();
      if (reasoningPanel) reasoningPanel.hidden = true;
      reasoningCard?.classList.remove('is-open');
    },
  };

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
  // Вставляем перед «якорем» низа (индикатор работы), а не в конец сообщения:
  // иначе карточки действий встают после всего текста, и ответ, написанный
  // ПОСЛЕ вызовов, оказывается выше них. С якорем порядок — порядок прихода.
  container.insertBefore(root, anchor);

  const sync = (): void => {
    // Заголовок — имена действий, а счётчик — серым рядом: в шапке видно, ЧТО
    // делал агент, а не сколько раз он это делал. Слово «Действия» больше не
    // нужно: список имён говорит то же самое, но конкретнее.
    const brief = names.slice(0, 2).join(', ');
    title.textContent = names.length > 2 ? `${brief} и ещё ${names.length - 2}` : brief || 'Действия';
    // В сводке: сколько было вызовов и сколько файлов они тронули. Файлы —
    // чтобы свёрнутая группа не прятала факт правок (подробности — в панели
    // «Изменён N файл» композера).
    const briefParts: string[] = [];
    if (count > 1) briefParts.push(`${count} ${plural(count, 'вызов', 'вызова', 'вызовов')}`);
    if (changedFiles > 0) briefParts.push(`${changedFiles} ${fileWord(changedFiles)}`);
    tools.textContent = briefParts.length > 0 ? `· ${briefParts.join(' · ')}` : '';

    if (pending > 0) {
      state.textContent = 'выполняется';
      state.className = 'tool-group-state is-running';
      return;
    }

    state.textContent = failed > 0 ? `ошибок: ${failed}` : 'готово';
    state.className = `tool-group-state${failed > 0 ? ' is-fail' : ' is-ok'}`;
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
        toolIconNode(call.name, call.args),
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
        // Ряд файлов появляется только у удачного вызова: под ошибкой список
        // тронутого обещал бы изменения, которых нет.
        // Тронутые файлы отдельным рядом не показываем: список — в сводке шапки
        // (счётчиком) и в панели «Изменён N файл» композера. Ряд чипов дублировал
        // её и растягивал ленту на строку под каждым вызовом.
        if (result.ok) changedFiles += touchedFiles(call.name, call.args, result.changes).length;
        sync();
      },
    };
  };

  /**
   * Закрываем группу: дальше идёт текст ответа или новый вопрос.
   * Строка-одиночка группы не требует — она читается и без шапки, поэтому
   * распускаем её наружу. Сама группа при этом жива: шапка раскрывает строки.
   */
  const seal = (): void => {
    const items = count + (reasoningCard ? 1 : 0);
    if (items === 0) {
      root.remove();
      return;
    }
    if (items === 1) {
      const solo = reasoningCard ?? (body.querySelector('.tool-card') as HTMLElement | null);
      if (solo) {
        solo.remove();
        root.replaceWith(solo);
      }
      return;
    }
  };

  return { add, reasoning: () => reasoning, seal };
}

/**
 * Лента вызовов инструментов.
 *
 * Агент за один шаг читает десяток файлов, и строка на каждый вызов
 * превращает чат в свалку. Поэтому подряд идущие вызовы собираются в одну
 * группу: в ленте остаётся её шапка («Просмотр папки, Чтение файла и ещё 2
 * · 6 · готово»), а сами строки — под раскрытием.
 */
export function createToolFeed(
  container: HTMLElement,
  anchor: Node | null = null,
  onUpdate?: () => void,
): {
  add(call: ChatToolStartPayload): ToolCardView;
  reasoning(): ReasoningRowView;
  seal(): void;
} {
  let current: ToolGroupView | null = null;
  const ensure = (): ToolGroupView => (current ??= createToolGroup(container, anchor, onUpdate));

  return {
    add: (call) => ensure().add(call),
    // Размышления открывают ту же группу, что и вызовы: в ленте это соседние
    // строки одного шага работы, а не отдельный блок над сообщением.
    reasoning: () => ensure().reasoning(),
    seal: () => {
      current?.seal();
      current = null;
    },
  };
}
