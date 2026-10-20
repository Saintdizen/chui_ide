import type { ChatToolResultPayload, ChatToolStartPayload } from '../../shared/api';
import { formatCallTime } from '../../shared/duration';
import { touchedFiles } from '../../shared/tool-files';
import { highlightInto } from '../core/highlight';
import { languageFromPath } from '../core/languages';
import { fileWord, plural } from './chat-text';
import { basename, h, pulseOnClick, svgIcon, type IconName } from './dom';
import { showToast } from './toast';
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
  // Старые имена остаются: в истории бесед трассы прошлых прогонов уже записаны.
  list: 'Просмотр',
  read: 'Чтение',
  list_dir: 'Просмотр папки',
  read_file: 'Чтение файла',
  read_files: 'Чтение файлов',
  read_image: 'Просмотр картинки',
  search: 'Поиск по проекту',
  project_map: 'Карта проекта',
  file_outline: 'Скелет файла',
  find_files: 'Поиск файлов',
  get_diagnostics: 'Диагностика',
  edit: 'Правка файлов',
  replace_in_files: 'Замена по проекту',
  create_file: 'Создание файла',
  delete_file: 'Удаление',
  move_file: 'Перемещение',
  update_plan: 'План',
  ask: 'Вопрос агента',
  task: 'Подзадача',
  browser: 'Браузер',
  git_read: 'Чтение git',
  git_write: 'Действие git',
  open_file: 'Открытие файла',
  present: 'Результат',
  terminal: 'Терминал',
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
  file_outline: 'checklist',
  find_files: 'folder',
  get_diagnostics: 'warning',
  edit: 'wrench',
  replace_in_files: 'refresh',
  create_file: 'filePlus',
  delete_file: 'trash',
  move_file: 'file',
  update_plan: 'command',
  ask: 'bubble',
  task: 'sparkle',
  browser: 'search',
  git_read: 'branch',
  git_write: 'branch',
  open_file: 'file',
  present: 'checkCircle',
  terminal: 'terminal',
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
  schedule: { create: 'Новая задача по расписанию', update: 'Правка задачи', delete: 'Удаление задачи' },
  git_read: {
    status: 'Состояние git',
    diff: 'Diff git',
    log: 'История git',
    blame: 'Автор строк',
  },
  git_write: {
    stage: 'Индекс git',
    unstage: 'Снятие с индекса',
    commit: 'Коммит',
    checkout: 'Смена ветки',
    discard: 'Откат изменений',
    fetch: 'Получение из remote',
    pull: 'Вливание из remote',
    push: 'Отправка в remote',
  },
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

function setToolState(element: HTMLElement, ok: boolean): void {
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
type OpenFileHandler = (path: string) => Promise<void>;

function createToolGroup(
  container: HTMLElement,
  anchor: Node | null,
  onUpdate: (() => void) | undefined,
  onOpenFile: OpenFileHandler | undefined,
): ToolGroupView {
  let count = 0;
  let pending = 0;
  let failed = 0;
  /** Сколько файлов тронули вызовы группы: видно в сводке, когда группа свёрнута. */
  let changedFiles = 0;
  /**
   * Раскрыта ли группа. По умолчанию свёрнута: в шапке видно ЧТО делал агент и
   * сколько, а десяток строк под ней — шум, который мешает читать ответ. Открыть
   * их должен человек; во время работы состояние сами не трогаем.
   */
  let expanded = false;
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
      'aria-expanded': 'false',
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

  const root = h('div', { class: 'tool-group' }, head, body);
  // Группа свёрнута по умолчанию: приводим тело и шеврон к состоянию `expanded`.
  applyExpanded();
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
    if (changedFiles > 0) briefParts.push(`${changedFiles} ${fileWord(changedFiles)}`);
    setBrief(briefParts.length > 0 ? `· ${briefParts.join(' · ')}` : '');

    if (pending > 0) {
      paintToolState(state, 'tool-group-state', 'running');
      return;
    }

    paintToolState(state, 'tool-group-state', failed > 0 ? 'fail' : 'ok');
  };

  const add = (call: ChatToolStartPayload): ToolCardView => {
    count += 1;
    pending += 1;
    const label = toolLabel(call.name, call.args);
    if (!names.includes(label)) names.push(label);

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
          void onOpenFile(item.path).catch(() => showToast('Не удалось открыть файл', 'error'));
        });
        open.disabled = onOpenFile === undefined;
        if (!onOpenFile) open.title = item.path;
        list.appendChild(open);
      }
      return list;
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
        setToolState(cardState, result.ok);
        // Файлы-результаты показываем сразу и вне раскрытия: это то, ради чего
        // вызов и делался. Место — между шапкой и панелью, чтобы кнопки были видны.
        if (result.ok && result.presented?.length) {
          const block = presentBlock(result.presented);
          card.insertBefore(block, panel);
        }
        card.classList.toggle('tool-failed', !result.ok);
        // Сколько шло: у долгой сборки это главное, что можно сказать о вызове.
        const spent = result.ms !== undefined && result.ms > 0 ? formatCallTime(result.ms) : '';
        time.textContent = spent;
        time.title = spent ? `Выполнялось ${spent}` : '';
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
  /** Чем открыть файл-результат: см. `OpenFileHandler`. */
  onOpenFile?: OpenFileHandler,
): {
  add(call: ChatToolStartPayload): ToolCardView;
  reasoning(): ReasoningRowView;
  seal(): void;
} {
  let current: ToolGroupView | null = null;
  const ensure = (): ToolGroupView => (current ??= createToolGroup(container, anchor, onUpdate, onOpenFile));

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
