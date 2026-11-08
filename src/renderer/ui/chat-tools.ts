import type { ChatToolResultPayload, ChatToolStartPayload , ToolSubagent } from '../../shared/api';
import { formatCallTime } from '../../shared/duration';
import { touchedFiles } from '../../shared/tool-files';
import { highlightInto } from '../core/highlight';
import { languageFromPath } from '../core/languages';
import { fileWord, plural } from './chat-text';
import { basename, h, pulseOnClick, svgIcon, type IconName } from './dom';
import { showToast } from './toast';
import { fileIcon } from './file-icons';
import type { RunFold } from './run-fold';

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
  // Старые имена остаются: в истории бесед трассы прошлых прогонов уже записаны.
  list: 'Просмотр',
  read: 'Чтение',
  list_dir: 'Просмотр папки',
  read_file: 'Чтение файла',
  read_files: 'Чтение файлов',
  read_image: 'Просмотр картинки',
  search: 'Поиск по проекту',
  project_map: 'Карта проекта',
  find_files: 'Поиск файлов',
  get_diagnostics: 'Диагностика',
  edit: 'Правка файлов',
  replace_in_files: 'Замена по проекту',
  delete_file: 'Удаление',
  move_file: 'Перемещение',
  plan: 'План',
  ask: 'Вопрос агента',
  task: 'Подзадача',
  browser: 'Браузер',
  show: 'Показ',
  terminal: 'Терминал',
  lsp: 'Символы и скелет',
  checks: 'Проверки',
  mcp: 'Ресурсы MCP',
  web: 'Сеть',
  file: 'Файлы',
  mind: 'Память',
};

/** У инструмента свой значок: строка читается без чтения подписи. */
const TOOL_ICONS: Record<string, IconName> = {
  list: 'folder',
  read: 'file',
  list_dir: 'folder',
  read_file: 'file',
  read_files: 'file',
  read_image: 'file',
  search: 'search',
  project_map: 'panel',
  find_files: 'folder',
  get_diagnostics: 'warning',
  edit: 'wrench',
  replace_in_files: 'refresh',
  delete_file: 'trash',
  move_file: 'file',
  plan: 'command',
  ask: 'bubble',
  task: 'sparkle',
  browser: 'search',
  show: 'file',
  terminal: 'terminal',
  lsp: 'checklist',
  checks: 'warning',
  mcp: 'panel',
  web: 'search',
  file: 'file',
  mind: 'sparkle',
};

/** Подписи действий у слитых инструментов: карточка говорит, что именно случилось. */
const TOOL_ACTION_LABELS: Record<string, Record<string, string>> = {
  browser: {
    open: 'Открытие страницы',
    snapshot: 'Снимок страницы',
    click: 'Клик на странице',
    type: 'Ввод на странице',
    evaluate: 'Скрипт на странице',
    zoom: 'Масштаб страницы',
    close: 'Закрытие браузера',
  },
  terminal: {
    list: 'Список терминалов',
    start: 'Запуск в терминале',
    read: 'Чтение терминала',
    write: 'Ввод в терминал',
    stop: 'Остановка терминала',
    run: 'Команда в терминале',
    output: 'Вывод задания',
    cancel: 'Остановка задания',
  },
  edit: { patch: 'Правка по якорю', position: 'Правка по позициям' },
  lsp: { references: 'Где используется символ', definition: 'К объявлению символа' },
  checks: { diagnostics: 'Диагностика', lint: 'Линтер' },
  mcp: { list: 'Каталог ресурсов MCP', read: 'Чтение ресурса MCP' },
  web: { search: 'Поиск в интернете', fetch: 'Чтение страницы' },
  file: { create: 'Создание файла', move: 'Перемещение', delete: 'Удаление' },
  mind: { remember: 'Заметка в память', forget: 'Забыть заметки' },
};

export function toolLabel(name: string, raw?: string): string {
  const actions = TOOL_ACTION_LABELS[name];
  if (actions && raw) {
    try {
      const action = (JSON.parse(raw) as { action?: unknown }).action;
      if (typeof action === 'string' && actions[action]) return actions[action];
    } catch {
      // не JSON — останется общая подпись инструмента
    }
  }
  return TOOL_LABELS[name] ?? name;
}

function toolIcon(name: string): IconName {
  return TOOL_ICONS[name] ?? 'wrench';
}

/** Путь файла, если инструмент работает явно с одним файлом; иначе null. */
function toolFilePath(name: string, raw: string): string | null {
  if (name === 'list' || name === 'list_dir') return null; // каталог или маска, а не файл
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
/**
 * Строка, на которую указывает вызов: `line` или `start_line` из аргументов.
 *
 * Из JSON, а не из подписи: подпись сокращают до «app.ts:120 · 5 мест», и у
 * разных инструментов она разная. Нет числа — прыгаем в начало файла: это
 * всё равно полезнее, чем ничего.
 */
function toolStartLine(raw: string): number | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    for (const key of ['line', 'start_line', 'startLine']) {
      const value = (parsed as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Путь покороче для ленты: абсолютный занимает полстроки и не читается.
 * Последние две части — «src/main/app.ts»; в одном файле хватает имени.
 */
function shortPath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter((part) => part.length > 0);
  if (parts.length <= 2) return parts.join('/');
  return parts.slice(-2).join('/');
}

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
    if (typeof value.description === 'string') parts.push(value.description);
    if (typeof value.from === 'string' && typeof value.to === 'string') parts.push(`${value.from} → ${value.to}`);
    if (typeof value.query === 'string') parts.push(`«${value.query}»`);
    if (typeof value.glob === 'string') parts.push(value.glob);
    if (typeof value.command === 'string') parts.push(value.command);
    if (typeof value.id === 'string') parts.push(value.id);
    if (typeof value.data === 'string') parts.push(`«${value.data.replace(/\n/g, '⏎').slice(0, 40)}»`);
    if (typeof value.question === 'string') parts.push(`«${value.question.replace(/\s+/g, ' ').trim().slice(0, 80)}»`);
    if (Array.isArray(value.steps)) parts.push(`${value.steps.length} шагов`);
    // edit: в карточке нужны имена файлов, а не сырой JSON на 80 символов.
    // Файлы лежат в `edits` (по позициям) или в `patches` (по якорю).
    const batch = Array.isArray(value.edits) ? value.edits : value.patches;
    if (Array.isArray(batch)) {
      for (const file of batch) {
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

/**
 * Секция раскрытой карточки: аргументы, результат. Заголовок с действием
 * «Копировать» — значком-кнопкой, как под сообщением: подпись живёт в подсказке,
 * ряд не шумит.
 */
function toolSection(title: string, text: string, body?: HTMLElement): HTMLElement {
  const section = h('section', { class: 'tool-section' }, toolSectionHead(title, text));
  if (body) section.appendChild(body);
  return section;
}

/** Заголовок секции с действием «Копировать». */
function toolSectionHead(title: string, text: string): HTMLElement {
  const copy = h(
    'button',
    {
      class: 'icon-btn',
      type: 'button',
      title: 'Копировать',
      'aria-label': 'Копировать',
      onClick: () => {
        void navigator.clipboard.writeText(text).then(
          () => showToast('Скопировано'),
          () => showToast('Не удалось скопировать', 'error'),
        );
      },
    },
    svgIcon('copy', 12),
  );
  pulseOnClick(copy);
  return h('div', { class: 'tool-section-head' }, h('span', { class: 'tool-section-title' }, title), copy);
}

/**
 * Аргументы вызова как их видит человек: JSON с отступами. В строке карточки они
 * сжаты до одной подписи (путь, запрос, маска), а здесь видно всё, включая то,
 * что в подпись не попало, — иначе непонятно, почему инструмент сделал именно это.
 * `null` — показывать нечего: пустой объект у инструмента без аргументов.
 */
function argsBlock(raw: string): { text: string; body: HTMLElement } | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '{}') return null;
  let text = trimmed;
  try {
    text = JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    // Не JSON — значит уже текст; показать его честнее, чем молчать.
  }
  const code = h('code', {});
  highlightInto(code, text, 'json');
  return { text, body: h('pre', { class: 'tool-raw' }, code) };
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
  // Вывод терминала — это команда и её текст: подсветка как у оболочки.
  if (call.name === 'terminal') {
    try {
      const action = (JSON.parse(call.args) as { action?: unknown }).action;
      return action === 'run' || action === 'start' || action === 'write' || action === 'output' ? 'shell' : '';
    } catch {
      return '';
    }
  }
  const single = ['read', 'read_file', 'list', 'list_dir'];
  if (!single.includes(call.name)) return '';
  try {
    const args = JSON.parse(call.args) as { path?: unknown };
    return typeof args.path === 'string' ? languageFromPath(args.path) : '';
  } catch {
    return ''; // аргументы не разобрались — покажем текстом, это не ошибка
  }
}

/** Состояние вызова: идёт работа, готово или ошибка. */
type ToolState = 'running' | 'ok' | 'fail';

/** Что значит каждый значок — словами: нужны подсказке и озвучке. */
const TOOL_STATE_LABEL: Record<ToolState, string> = {
  running: 'выполняется',
  ok: 'готово',
  fail: 'ошибка',
};
/** Какой значок отвечает состоянию: галочка в круге, крест в круге, круг «идёт». */
const TOOL_STATE_ICON: Record<ToolState, IconName> = {
  running: 'spinner',
  ok: 'checkCircle',
  fail: 'xCircle',
};

/**
 * Нарисовать состояние значком, а не словом: итог вызова видно с одного взгляда,
 * и значок не спорит шириной с подписью. Круг «в работе» ещё и вращается — тут
 * движение по делу: оно показывает, что процесс жив, а не украшает.
 *
 * Слово не выбрасываем совсем: оно уходит в `title` и `aria-label` — иначе значок
 * не прочитать ни подсказкой, ни экранным диктором.
 */
function paintToolState(element: HTMLElement, base: string, state: ToolState): void {
  element.className = `${base} is-${state}`;
  element.replaceChildren(svgIcon(TOOL_STATE_ICON[state], 14));
  element.title = TOOL_STATE_LABEL[state];
  element.setAttribute('aria-label', TOOL_STATE_LABEL[state]);
}

/** Строка состояния вызова: значок «идёт работа», который сменится итогом. */
function toolStateElement(): HTMLElement {
  const element = h('span', { class: 'tool-state' });
  paintToolState(element, 'tool-state', 'running');
  return element;
}

function setToolState(element: HTMLElement, ok: boolean, failed = false): void {
  // `failed` — итог неудачный, но инструмент сработал: упавший тест это результат,
  // а не поломка. Значок галочки с подписью «завершено с ненулевым кодом»
  // не врёт и не красит карточку в красное.
  if (ok && failed) {
    element.className = 'tool-state is-ok is-failed';
    element.replaceChildren(svgIcon('checkCircle', 14));
    element.title = 'завершено: результат отрицательный';
    element.setAttribute('aria-label', element.title);
    return;
  }
  paintToolState(element, 'tool-state', ok ? 'ok' : 'fail');
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

/**
 * Чем открыть файл-результат (`present`). Клику в ленте мало одного `editors.reveal`:
 * среди открытых документа может и не быть — агент только что его создал.
 */
type OpenFileHandler = (path: string, position?: { line?: number; column?: number }) => Promise<void>;

/**
 * Чем занят агент прямо сейчас — одной строкой («правит agent-edit.ts»).
 *
 * Наружу это нужно потому, что свёрнутая группа в ленте видна только тем, кто
 * на ленту смотрит. Из другого файла видно лишь «что-то идёт» — и не понять,
 * правит он или читает. `null` — работа кончилась.
 */
type BusyHintHandler = (hint: string | null) => void;

/** Строка для шапки и дока: что делает вызов. Файл — из аргументов, пока они на руках. */
function busyHintFor(call: ChatToolStartPayload): string {
  const label = toolLabel(call.name, call.args);
  const file = toolFilePath(call.name, call.args);
  if (!file) return label;
  return `${label} ${file.split(/[\\/]/).pop() ?? file}`;
}

function createToolGroup(
  container: HTMLElement,
  anchor: Node | null,
  onUpdate: (() => void) | undefined,
  onOpenFile: OpenFileHandler | undefined,
  /** Чем группа занята сейчас — одной строкой, для шапки панели и дока. */
  onBusyHint: BusyHintHandler | undefined,
  /**
   * Общий режим раскрытия ленты. Группа спрашивает его при создании и слушает
   * смену: иначе «свернуть всё» обходило бы только уже созданные группы, а
   * следующая — появившаяся через секунду работы — снова была бы свёрнутой.
   */
  fold: RunFold | undefined,
  /**
   * Перейти к изменениям из сообщения. Счётчик файлов в шапке — не только
   * надпись: у него есть куда вести, и это главное для кого-то, кто смотрит
   * на ответ со стороны.
   */
  onOpenChanges: ((path?: string) => void) | undefined,
): ToolGroupView {
  let count = 0;
  let pending = 0;
  /** Сколько вызовов сломалось: это ошибка и по значку, и по счёту. */
  let failed = 0;
  /** Сколько вызовов отработало с отрицательным итогом: упавшие тесты, ненулевой код. */
  let negative = 0;
  /** Сколько файлов тронули вызовы группы: видно в сводке, когда группа свёрнута. */
  let changedFiles = 0;
  /**
   * Файл, к которому ведёт счётчик. Не все сразу: в шапке один счётчик, и он
   * ведёт туда, где видны остальные.
   */
  let lastTouched: string | undefined;
  /**
   * Раскрыта ли группа. По умолчанию свёрнута: в шапке видно ЧТО делал агент и
   * сколько, а десяток строк под ней — шум, который мешает читать ответ. Открыть
   * их должен человек; во время работы состояние сами не трогаем.
   */
  let expanded = fold?.mode() === 'expanded';
  const names: string[] = [];

  const title = h('span', { class: 'tool-group-title' }, 'Действия');
  const tools = h('span', { class: 'tool-group-tools' });
  const state = h('span', { class: 'tool-group-state' });
  paintToolState(state, 'tool-group-state', 'running');
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
      'aria-expanded': String(expanded),
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

  const filesButton = h(
    'button',
    {
      class: 'tool-group-files',
      type: 'button',
      hidden: true,
      title: 'Показать изменённые файлы',
      onClick: () => onOpenChanges?.(),
    },
    svgIcon('file', 12),
    h('span', { class: 'tool-group-files-count' }),
    h('span', { class: 'tool-group-files-word' }),
  );

  const root = h('div', { class: 'tool-group' }, head, filesButton, body);

  /**
   * Счётчик файлов готов к клику или прячется.
   *
   * Без перехода (`onOpenChanges` не дали) кнопка не нужна — но и терять число
   * нельзя: оно остаётся в сводке шапки (`changedFiles` в brief).
   */
  const syncFilesButton = (): void => {
    const show = changedFiles > 0 && onOpenChanges !== undefined;
    filesButton.hidden = !show;
    if (!show) return;
    filesButton.querySelector('.tool-group-files-count')!.textContent = String(changedFiles);
    filesButton.querySelector('.tool-group-files-word')!.textContent = fileWord(changedFiles);
    filesButton.title = lastTouched
      ? `Изменено файлов: ${changedFiles} — открыть ${lastTouched}`
      : `Изменено файлов: ${changedFiles}`;
  };
  // Группа свёрнута по умолчанию: приводим тело и шеврон к состоянию `expanded`.
  applyExpanded();
  /**
   * «Свернуть всё» — это указание, а не разовое действие: оно берёт и уже
   * созданные группы, и все следующие (те спросят `mode()` при создании).
   * `auto` возвращает каждой группе её естественное состояние — свёрнута.
   */
  const unlisten = fold?.onChange((next) => {
    expanded = next === 'expanded';
    head.setAttribute('aria-expanded', String(expanded));
    applyExpanded();
  });
  // Подписка живёт вместе с группой. Снимаем её явно: там, где группа уходит
  // (`seal` распускает одиночку) и при закрытии всего фида. Обойтись без этого
  // нельзя: у `onChange` нет слабых ссылок, и перерисовка ленты оставила бы в
  // слушателях мёртвые группы — «свернуть всё» ходило бы по отвязанным узлам.
  const dropListen = (): void => unlisten?.();
  // Вставляем перед «якорем» низа (индикатор работы), а не в конец сообщения:
  // иначе карточки действий встают после всего текста, и ответ, написанный
  // ПОСЛЕ вызовов, оказывается выше них. С якорем порядок — порядок прихода.
  container.insertBefore(root, anchor);

  /** Сводка изменилась — короткий фейд: текст не «моргает» подменой. */
  const setBrief = (value: string): void => {
    if (tools.textContent === value) return;
    tools.textContent = value;
    tools.classList.remove('is-updated');
    // Перезапуск анимации: чтение раскладки сбрасывает прежний прогон.
    void tools.offsetWidth;
    tools.classList.add('is-updated');
  };

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
    // Сколько из вызовов упало — числом: значок говорит «есть ошибка», а счётчик —
    // сколько их. Терять это нельзя: по одному кресту не понять размах.
    if (failed > 0) briefParts.push(`ошибок: ${failed}`);
    // Отрицательный итог — не ошибка инструмента, поэтому и слово другое: иначе
    // упавший тест читался бы как поломка вызова.
    if (negative > 0) briefParts.push(`с отрицательным итогом: ${negative}`);
    if (changedFiles > 0 && onOpenChanges === undefined) {
      briefParts.push(`${changedFiles} ${fileWord(changedFiles)}`);
    }
    setBrief(briefParts.length > 0 ? `· ${briefParts.join(' · ')}` : '');
    // Счётчик файлов: без перехода — просто надпись, с переходом — кнопка.
    syncFilesButton();

    if (pending > 0) {
      paintToolState(state, 'tool-group-state', 'running');
      return;
    }

    // Ставка на худшее: поломка важнее отрицательного итога, а значок в шапке
    // один. «Отрицательный» без ошибок — жёлтая галочка, как у карточки.
    if (failed === 0 && negative > 0) {
      state.className = 'tool-group-state is-ok is-failed';
      state.replaceChildren(svgIcon('checkCircle', 14));
      state.title = 'завершено: у части вызовов результат отрицательный';
      state.setAttribute('aria-label', state.title);
      return;
    }
    paintToolState(state, 'tool-group-state', failed > 0 ? 'fail' : 'ok');
  };

  const add = (call: ChatToolStartPayload): ToolCardView => {
    count += 1;
    pending += 1;
    const label = toolLabel(call.name, call.args);
    if (!names.includes(label)) names.push(label);
    // Наружу — что именно правит агент, а не просто «что-то идёт». Файл берём
    // из аргументов вызова, пока он на руках: в DOM его пришлось бы потом
    // выковыривать обратно.
    onBusyHint?.(busyHintFor(call));

    /**
     * Файлы-результаты («вот что я сделал»). Это не раздел внутри раскрытия: если
     * человеку нужно нажать «Открыть», он не должен сперва догадаться раскрыть
     * карточку. Путь и кнопка — по строке на файл; имя показываем, полный путь —
     * в подсказке, чтобы узкая панель не рвалась по слогам.
     */
    const presentBlock = (items: ChatToolResultPayload['presented']): HTMLElement => {
      const list = h('div', { class: 'tool-present' });
      for (const item of items ?? []) {
        const name = item.path.split(/[\\/]/).pop() ?? item.path;
        const open = h(
          'button',
          { class: 'btn btn-small tool-present-open', type: 'button', title: `Открыть ${item.path}` },
          svgIcon('file', 12),
          h('span', { class: 'tool-present-name' }, item.note ? `${name} — ${item.note}` : name),
        );
        open.addEventListener('click', () => {
          // Без обработчика кнопка не притворяется рабочей: подсказка говорит, чего нет.
          if (!onOpenFile) {
            showToast('Открыть файл здесь нечем', 'error');
            return;
          }
          void onOpenFile(item.path, item).catch(() => showToast('Не удалось открыть файл', 'error'));
        });
        open.disabled = onOpenFile === undefined;
        if (!onOpenFile) open.title = item.path;
        list.appendChild(open);
      }
      return list;
    };

    /**
     * Путь из аргументов — ссылкой. Клик по шапке раскрывает разбор, поэтому
     * клик по ссылке гасим: иначе одно нажатие делало бы два дела.
     */
    const pathLink = (callPayload: ChatToolStartPayload): HTMLElement | null => {
      const path = toolFilePath(callPayload.name, callPayload.args);
      if (path === null) return null;
      const line = toolStartLine(callPayload.args);
      const name = shortPath(path);
      const where = line !== null ? `${name}:${line}` : name;
      const open = (): void => void onOpenFile?.(path, { line: line ?? 1, column: 1 });
      const link = h('span', { class: 'tool-path', role: 'link', tabindex: '0', title: `Открыть ${where}` }, where);
      link.addEventListener('click', (event) => {
        event.stopPropagation();
        open();
      });
      link.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        open();
      });
      return link;
    };

    const cardState = toolStateElement();
    const panel = h('div', { class: 'tool-panel', hidden: true });
    const card = h('div', { class: 'tool-card' });
    // Время вызова появляется вместе с результатом: до него говорить нечего.
    const time = h('span', { class: 'tool-time' });
    const rowChevron = svgIcon('chevronDown', 12);
    rowChevron.classList.add('tool-chevron');

    let outcome: ChatToolResultPayload | null = null;
    const detailLanguage = toolDetailLanguage(call);

    /**
     * Раскрытая карточка — это разбор вызова, а не одна простыня: чем инструмент
     * позвали, что он ответил и чем кончилось. У инструмента чтения и у команды
     * одного взгляда мало: в подписи строки видно только путь или команду.
     */
    const togglePanel = (): void => {
      if (!outcome) return;
      if (panel.childElementCount === 0) {
        const args = argsBlock(call.args);
        if (args) panel.appendChild(toolSection('Аргументы', args.text, args.body));

        const result = h('section', { class: 'tool-section' });
        result.appendChild(
          toolSectionHead('Результат', [outcome.summary, outcome.detail ?? ''].filter(Boolean).join('\n\n')),
        );
        result.appendChild(h('div', { class: 'tool-summary' }, outcome.summary));
        if (outcome.detail) {
          const raw = h('code', {});
          highlightInto(raw, outcome.detail, detailLanguage);
          result.appendChild(h('pre', { class: 'tool-raw' }, raw));
        }
        panel.appendChild(result);
        // Картинка, которую посмотрел агент: без неё карточка говорит «смотрел
        // макет», а человек не знает, какой. Ссылку на подпись не даём — data-URL
        // в заголовке читался бы простынёй, копировать надо путь из аргументов.
        if (outcome.images?.length) {
          const gallery = h('section', { class: 'tool-section' });
          gallery.appendChild(toolSectionHead('Изображение', outcome.summary));
          for (const src of outcome.images) {
            const picture = h('img', { class: 'tool-image', alt: 'Изображение, которое посмотрел агент' });
            picture.src = src;
            gallery.appendChild(picture);
          }
          panel.appendChild(gallery);
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
        // Путь — ссылкой, а не текстом: в ленте «read src/main/app.ts:120»
        // бесполезен, пока в него нельзя прыгнуть.
        pathLink(call),
        h('span', { class: 'tool-args' }, summarizeArgs(call.args)),
        time,
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
        setToolState(cardState, result.ok, result.failed);
        // Файлы-результаты показываем сразу и вне раскрытия: это то, ради чего
        // вызов и делался. Место — между шапкой и панелью, чтобы кнопки были видны.
        if (result.ok && result.presented?.length) {
          const block = presentBlock(result.presented);
          card.insertBefore(block, panel);
        }
        // Подзадачи — вложенными карточками под своим `task`: их читают как
        // отдельные ходы, а не как строки сводного отчёта.
        if (result.subagents?.length) {
          const wrap = h('div', { class: 'tool-subtasks' });
          for (const task of result.subagents) wrap.appendChild(subtaskCard(task));
          card.insertBefore(wrap, panel);
        }
        card.classList.toggle('tool-failed', !result.ok);
        // Сколько шло: у долгой сборки это главное, что можно сказать о вызове.
        const spent = result.ms !== undefined && result.ms > 0 ? formatCallTime(result.ms) : '';
        time.textContent = spent;
        time.title = spent ? `Выполнялось ${spent}` : '';
        pending -= 1;
        if (!result.ok) failed += 1;
        else if (result.failed) negative += 1;
        // Ряд файлов появляется только у удачного вызова: под ошибкой список
        // тронутого обещал бы изменения, которых нет.
        // Тронутые файлы отдельным рядом не показываем: список — в сводке шапки
        // (счётчиком) и в панели «Изменён N файл» композера. Ряд чипов дублировал
        // её и растягивал ленту на строку под каждым вызовом.
        if (result.ok) {
          const touched = touchedFiles(call.name, call.args, result.changes);
          changedFiles += touched.length;
          // Последний тронутый — адрес для перехода. Не все файлы сразу: в
          // шапке один счётчик, и он ведёт туда, где видны остальные.
          lastTouched = touched[0]?.path ?? lastTouched;
        }
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
      dropListen();
      root.remove();
      return;
    }
    if (items === 1) {
      const solo = reasoningCard ?? (body.querySelector('.tool-card') as HTMLElement | null);
      if (solo) {
        // Одиночка выходит из группы и становится самостоятельной: режим
        // раскрытия группы ей больше не указ, и слушатель ни к чему.
        dropListen();
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

/** Вложенная карточка подзадачи: описание, счёт и итог под сворачиванием. */
function subtaskCard(task: ToolSubagent): HTMLElement {
  const tokens = task.inputTokens + task.outputTokens;
  const counts = [plural(task.steps, 'шаг', 'шага', 'шагов')];
  if (tokens > 0) counts.push(`${tokens} токенов`);
  const head = h('div', { class: 'tool-subtask-head' }, task.description, h('span', { class: 'tool-subtask-count' }, counts.join(' · ')));
  // Отчёт — под сворачиванием: без него человек не верит карточке, с ним
  // раскрытой она перекрывает саму беседу. Свёрнуты все, даже одна.
  const body = h('div', { class: 'tool-subtask-body', hidden: true });
  if (task.failure !== undefined) {
    body.appendChild(h('div', { class: 'tool-subtask-fail' }, `Не вышло: ${task.failure}`));
  }
  if (task.text !== '') body.appendChild(h('pre', { class: 'tool-subtask-text' }, task.text));
  const card = h('div', { class: 'tool-subtask' }, head, body);
  card.classList.toggle('is-failed', task.failure !== undefined);
  head.addEventListener('click', () => {
    body.hidden = !body.hidden;
    card.classList.toggle('is-open', !body.hidden);
  });
  return card;
}

export function createToolFeed(
  container: HTMLElement,
  anchor: Node | null = null,
  onUpdate?: () => void,
  /** Чем открыть файл-результат: см. `OpenFileHandler`. */
  onOpenFile?: OpenFileHandler,
  /** Чем агент занят сейчас — для шапки панели и дока, не только для ленты. */
  onBusyHint?: BusyHintHandler,
  /** Общий режим раскрытия ленты — кнопка «свернуть всё» над беседой. */
  fold?: RunFold,
  /** Перейти к изменениям из сообщения — счётчик файлов в шапке группы. */
  onOpenChanges?: (path?: string) => void,
): {
  add(call: ChatToolStartPayload): ToolCardView;
  reasoning(): ReasoningRowView;
  seal(): void;
} {
  let current: ToolGroupView | null = null;
  const ensure = (): ToolGroupView =>
    (current ??= createToolGroup(container, anchor, onUpdate, onOpenFile, onBusyHint, fold, onOpenChanges));

  return {
    add: (call) => ensure().add(call),
    // Размышления открывают ту же группу, что и вызовы: в ленте это соседние
    // строки одного шага работы, а не отдельный блок над сообщением.
    reasoning: () => ensure().reasoning(),
    seal: () => {
      current?.seal();
      current = null;
      // Работы больше нет: шапка не должна продолжать говорить «правит файл».
      onBusyHint?.(null);
    },
  };
}
