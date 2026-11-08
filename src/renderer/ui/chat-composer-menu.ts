import type { ProjectCommand } from '../../shared/commands';
import { expandCommandPrompt } from '../../shared/commands';
import { CHAT_ACTIONS, type ChatActionId } from '../../shared/chat-actions';
import { clear, h } from './dom';

/**
 * Меню композера: слэш-команды и приложение контекста.
 *
 * «/» в начале строки открывает список готовых запросов, «#» в конце слова —
 * список контекста (выделение, файл, ошибки), «@» — файлы проекта. Одно меню на
 * три входа: открывается по содержимому поля ввода, навигация — стрелками, выбор —
 * Enter. Раньше всё это жило прямо в chat.ts; вынесено, чтобы панель не росла.
 *
 * Модуль знает только про своё поле ввода и просит приложить контекст через
 * колбэки: работа с редактором и проектом остаётся в панели.
 */

/** Пункт меню: подпись, пояснение и действие. */
export interface ComposerItem {
  title: string;
  hint: string;
  run(): void;
}

/** Тысячи — округлённо: в меню цифра нужна на глаз, а не до токена. */
function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const thousands = tokens / 1000;
  return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}k`;
}

/** Беседа в `@`-подсказке: подпись и uid, по которому её приложат. */
export interface MentionSession {
  uid: string;
  title: string;
}

/** Вид контекста, который прикладывают: им же помечен `#`-пункт. */
export type ContextKind =
  | 'selection'
  | 'file'
  | 'problems'
  /** Вывод терминала: ошибка сборки обычно видна только там. */
  | 'terminal'
  | 'diff'
  | 'codebase'
  | 'web'
  // Коммит и снимок экрана спрашиваю у человека: их нельзя взять «что видно сейчас».
  | 'commit'
  | 'screen';

/** Слэш-команды: подставляют готовый запрос и сами прикладывают контекст. */
const SLASH_COMMANDS: ReadonlyArray<{ id: string; title: string; hint: string; prompt: string }> = [
  {
    id: '/explain',
    title: 'Объяснить код',
    hint: 'Разобрать выделение или текущий файл',
    prompt: 'Объясни этот код: что он делает, как устроен и на что обратить внимание.',
  },
  {
    id: '/fix',
    title: 'Исправить ошибку',
    hint: 'Найти причину и предложить правку',
    prompt: 'Найди причину ошибок в этом коде и предложи минимальную правку.',
  },
  {
    id: '/tests',
    title: 'Написать тесты',
    hint: 'Покрыть выделение или файл тестами',
    prompt: 'Напиши тесты для этого кода. Покрой граничные случаи и объясни, что проверяешь.',
  },
  {
    id: '/doc',
    title: 'Добавить документацию',
    hint: 'Комментарии и docstring',
    prompt: 'Добавь документацию к этому коду: назначение, параметры, возвращаемое значение.',
  },
];

/** Сколько бесед показываем в `@`-подсказке: больше — и файл уже не найти. */
const MAX_MENTION_SESSIONS = 5;

/**
 * Сколько путей показывать в `#`-подсказке. Путей в проекте тысячи, и список
 * без потолка превращает подсказку в простыню, по которой не попасть стрелками.
 */
const MAX_MENTION_PATHS = 20;

const CONTEXT_COMMANDS: ReadonlyArray<{ id: string; title: string; hint: string; kind: ContextKind }> = [
  { id: '#selection', title: 'Выделение', hint: 'Фрагмент из редактора', kind: 'selection' },
  { id: '#file', title: 'Открытый файл', hint: 'Содержимое целиком', kind: 'file' },
  { id: '#problems', title: 'Ошибки и предупреждения', hint: 'То, что подчёркивает редактор', kind: 'problems' },
  // Вывод терминала: половина ошибок видна только там, а не в разметке редактора.
  { id: '#terminal', title: 'Вывод терминала', hint: 'Последние строки активной вкладки', kind: 'terminal' },
  // Правки проекта: без него модель не видит, что уже изменено, и предлагает сделать это второй раз.
  { id: '#diff', title: 'Мои правки', hint: 'Незакоммиченные изменения репозитория', kind: 'diff' },
  // Места по смыслу: модель видит не только открытый файл, а весь проект под вопрос.
  { id: '#codebase', title: 'Места в проекте', hint: 'Файлы и строки, близкие по смыслу', kind: 'codebase' },
  // Страница из встроенного браузера: адрес открытой вкладки — то, о чём речь.
  { id: '#web', title: 'Страница браузера', hint: 'Адрес открытой вкладки', kind: 'web' },
  // «Почему это сломалось» чаще отвечает коммит, а не файл.
  { id: '#commit', title: 'Коммит', hint: 'Заголовок и список файлов с числом строк', kind: 'commit' },
  // Экран: человек показывает, а не описывает словами.
  { id: '#screen', title: 'Снимок экрана', hint: 'Что видно в окне прямо сейчас', kind: 'screen' },
];

export interface ComposerMenuDeps {
  /** Поле ввода: меню открывается по его содержимому и подставляет текст. */
  input: HTMLTextAreaElement;
  /** Приложить контекст указанного вида (пункт `#`). */
  onContext(kind: ContextKind): void;
  /**
   * Сколько токенов уже приложено и сколько их стоит указанный вид. Меню не
   * считает само: вес берётся из одного расчёта (`shared/context-fit`), иначе
   * цифра в меню разошлась бы с кольцом заполнения. `null` — посчитать нечем:
   * тогда пункты показываются без цифр, как раньше.
   */
  contextCost?(kind: ContextKind): { attached: number; item: number } | null;
  /** Открыть выбор изображения. */
  onPickImage(): void;
  /** Приложить то, что открыто в редакторе (`selection` или `file`). */
  onAttachBest(): void;
  /** Приложить файл или папку проекта по пути от корня (`@`). */
  onMention(path: string): void;
  /** Пути проекта для `@`; null — список ещё не собирали. */
  mentionPaths(): readonly string[] | null;
  /** Попросить собрать список путей (зовётся, когда он ещё пуст). */
  requestMentions(): void;
  /** Команды проекта (`.chui/commands`); пустой список — их нет или они ещё не пришли. */
  projectCommands(): readonly ProjectCommand[];
  /** Беседы окна: их тоже можно приложить к вопросу — как `@`-файл. */
  sessions(): readonly MentionSession[];
  /** Приложить беседу по её uid (разговор целиком — как справку). */
  onMentionSession(uid: string): void;
  /** Пересобрать команды проекта: при смене папки и при первом `/`. */
  requestCommands(): void;
  /**
   * Своя команда беседы (`/compact`, `/new`, `/fork`). Меню не выполняет её само:
   * вкладки и контекст — дело панели, а не списка.
   */
  onChatAction(id: ChatActionId): void;
}

export interface ComposerMenuView {
  element: HTMLElement;
  /** Кнопка «+» открывает список контекста: так его видно и без `#`. */
  toggleContext(): void;
  /** Обновить меню по содержимому поля ввода. */
  sync(): void;
  /** Закрыть меню. */
  hide(): void;
  /** Сдвинуть курсор по списку; возвращает true, если меню было открыто. */
  moveCursor(delta: number): boolean;
  /** Выбрать текущий пункт; возвращает true, если меню было открыто. */
  pickCurrent(): boolean;
  /** Меню открыто. */
  isOpen(): boolean;
}

export function createComposerMenu(deps: ComposerMenuDeps): ComposerMenuView {
  const element = h('div', { class: 'composer-menu', hidden: true });
  let items: ComposerItem[] = [];
  let index = 0;

  function render(): void {
    clear(element);
    items.forEach((item, at) => {
      element.appendChild(
        h(
          'button',
          {
            class: `composer-menu-item${at === index ? ' is-cursor' : ''}`,
            type: 'button',
            onClick: () => pick(at),
          },
          h('span', { class: 'composer-menu-title' }, item.title),
          h('span', { class: 'composer-menu-hint' }, item.hint),
        ),
      );
    });
  }

  function show(next: ComposerItem[]): void {
    items = next;
    index = 0;
    if (next.length === 0) {
      hide();
      return;
    }
    render();
    element.hidden = false;
  }

  function hide(): void {
    element.hidden = true;
    items = [];
    index = 0;
  }

  function pick(at: number): void {
    const item = items[at];
    hide();
    item?.run();
  }

  /**
   * Хвост к подсказке пункта: цена вида и сумма по уже приложенному. Молчит,
   * пока цена неизвестна: пустая скобка хуже её отсутствия.
   */
  function costHint(kind: ContextKind, hint: string): string {
    const cost = deps.contextCost?.(kind) ?? null;
    if (!cost) return hint;
    const item = formatTokens(cost.item);
    // Сумма по приложенному важнее цены пункта: именно она растёт с каждым выбором.
    return cost.attached > 0 ? `${hint} · ${item}, всего ${formatTokens(cost.attached)}` : `${hint} · ≈${item}`;
  }

  /** Контекст одним списком: пункты `#` и выбор изображения из файла. */
  function contextItems(): ComposerItem[] {
    return [
      ...CONTEXT_COMMANDS.map((item) => ({
        title: item.title,
        hint: costHint(item.kind, item.hint),
        run: () => {
          deps.onContext(item.kind);
          deps.input.focus();
        },
      })),
      {
        title: 'Изображение из файла…',
        hint: 'PNG, JPEG, WebP, GIF — или Ctrl+V из буфера',
        run: () => deps.onPickImage(),
      },
    ];
  }

  function sync(): void {
    const value = deps.input.value;

    if (value.startsWith('/')) {
      const query = value.slice(1).toLowerCase();
      // Команды проекта — первыми: они про этот проект, и их ищут осознанно.
      // Встроенные остаются ниже: пока своих не завели, список тот же, что раньше.
      const own = deps
        .projectCommands()
        .filter((command) => command.name.startsWith(query))
        .map((command) => ({
          title: `/${command.name} — ${command.description}`,
          hint: command.scope === 'global' ? 'команда — общая' : 'команда проекта',
          run: () => {
            deps.input.value = expandCommandPrompt(command);
            // Заготовка прикладывает и прицепки из своей шапки: «посмотри дифф»
            // без диффа — это текст ни о чём.
            for (const kind of command.context ?? []) deps.onContext(kind);
            deps.onAttachBest();
            sync();
            deps.input.focus();
          },
        }));
      // Свои действия беседы — первыми: они не подставляют текст, а делают дело,
      // и искать их надо раньше чужих заготовок.
      const actions = CHAT_ACTIONS.filter((item) => item.command.slice(1).startsWith(query)).map((item) => ({
        title: `${item.command} — ${item.title}`,
        hint: item.hint,
        run: () => {
          deps.input.value = '';
          deps.onChatAction(item.id);
          deps.input.focus();
        },
      }));
      const builtin = SLASH_COMMANDS.filter((item) => item.id.slice(1).startsWith(query)).map((item) => ({
        title: `${item.id} — ${item.title}`,
        hint: item.hint,
        run: () => {
          deps.input.value = item.prompt;
          deps.onAttachBest();
          sync();
          deps.input.focus();
        },
      }));
      // Список ещё не пришёл — просим его: следующее нажатие `/` покажет команды.
      if (own.length === 0) deps.requestCommands();
      show([...actions, ...own, ...builtin]);
      return;
    }

    // `#` — один вход и для команд контекста, и для путей проекта.
    //
    // Разделять их нечем: `#sel` и `#src/app.ts` — одинаковый набор символов, и
    // угадывать по префиксу значило бы гадать. Поэтому показываем оба списка
    // подряд, команды первыми (их конечный список, путей может быть тысяча),
    // и сужаем по мере набора: набравший `#app` увидит путь, `#sel` — команду.
    const hash = value.lastIndexOf('#');
    if (hash >= 0 && /(^|\s)#[\w./-]*$/.test(value)) {
      const query = value.slice(hash + 1).toLowerCase();
      const commands = CONTEXT_COMMANDS.filter((item) => item.id.slice(1).startsWith(query)).map(
        (item) => ({
          title: `${item.id} — ${item.title}`,
          hint: costHint(item.kind, item.hint),
          run: () => {
            // Убираем набранный `#…`: он был только способом открыть список.
            deps.input.value = `${value.slice(0, hash).trimEnd()} `.trimStart();
            deps.onContext(item.kind);
            deps.input.focus();
          },
        }),
      );
      // Путь, набранный после `#`, ищем по вхождению: помнят «app.ts», а не
      // «src/main/app.ts». Слэш в набранном значит, что человек уже идёт по
      // папкам, — тогда сужаем по началу пути, чтобы не мешать вложенные.
      const paths = (deps.mentionPaths() ?? [])
        .filter((path) =>
          query.includes('/')
            ? path.toLowerCase().startsWith(query)
            : path.toLowerCase().includes(query),
        )
        .slice(0, MAX_MENTION_PATHS)
        .map((path) => ({
          title: `#${path}`,
          hint: 'файл проекта',
          run: () => {
            deps.input.value = `${value.slice(0, hash).trimEnd()} `.trimStart();
            deps.onMention(path);
            deps.input.focus();
          },
        }));
      // Список путей ещё собирают — просим его: следующий `#` покажет больше.
      if (paths.length === 0 && query.length > 0) deps.requestMentions();
      show([...commands, ...paths]);
      return;
    }

    // `@` — файл, папка проекта или прошлая беседа: так контекст прикладывается
    // точнее всего. Беседы идут первыми, но их немного (см. `MAX_MENTION_SESSIONS`):
    // набравший `@` чаще хочет файл, и очередь из разговоров оттеснила бы его.
    const at = value.lastIndexOf('@');
    if (at >= 0 && /(^|\s)@[\w./-]*$/.test(value)) {
      const query = value.slice(at + 1).toLowerCase();
      const paths = deps.mentionPaths();
      const candidates = (paths ?? []).filter((path) => path.toLowerCase().includes(query)).slice(0, 30);
      if (candidates.length === 0 && paths === null) deps.requestMentions();
      const clearMention = (): void => {
        deps.input.value = `${value.slice(0, at).trimEnd()} `.trimStart();
      };
      const chats = deps
        .sessions()
        // Ссылка на саму себя бессмысленна: разговор уже в контексте.
        .filter((session) => session.title.toLowerCase().includes(query))
        .slice(0, MAX_MENTION_SESSIONS)
        .map((session) => ({
          title: `беседа «${session.title}»`,
          hint: 'разговор — приложить как справку',
          run: () => {
            clearMention();
            deps.onMentionSession(session.uid);
            deps.input.focus();
          },
        }));
      show([
        ...chats,
        ...candidates.map((path) => {
          const isDir = path.endsWith('/');
          return {
            title: path,
            hint: isDir ? 'папка — список файлов' : 'файл — содержимое',
            run: () => {
              clearMention();
              deps.onMention(path);
              deps.input.focus();
            },
          };
        }),
      ]);
      return;
    }

    hide();
  }

  return {
    element,
    toggleContext: () => {
      if (!element.hidden) {
        hide();
        return;
      }
      show(contextItems());
    },
    sync,
    hide,
    moveCursor: (delta) => {
      if (element.hidden) return false;
      index = (index + delta + items.length) % items.length;
      render();
      return true;
    },
    pickCurrent: () => {
      if (element.hidden) return false;
      pick(index);
      return true;
    },
    isOpen: () => !element.hidden,
  };
}
