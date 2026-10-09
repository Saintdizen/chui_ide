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

/** Вид контекста, который прикладывают: им же помечен `#`-пункт. */
export type ContextKind = 'selection' | 'file' | 'problems';

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

const CONTEXT_COMMANDS: ReadonlyArray<{ id: string; title: string; hint: string; kind: ContextKind }> = [
  { id: '#selection', title: 'Выделение', hint: 'Фрагмент из редактора', kind: 'selection' },
  { id: '#file', title: 'Открытый файл', hint: 'Содержимое целиком', kind: 'file' },
  { id: '#problems', title: 'Ошибки и предупреждения', hint: 'То, что подчёркивает редактор', kind: 'problems' },
];

export interface ComposerMenuDeps {
  /** Поле ввода: меню открывается по его содержимому и подставляет текст. */
  input: HTMLTextAreaElement;
  /** Приложить контекст указанного вида (пункт `#`). */
  onContext(kind: ContextKind): void;
  /** Приложить лучшее из доступного (слэш-команда). */
  onAttachBest(): void;
  /** Открыть диалог выбора изображения. */
  onPickImage(): void;
  /** Приложить файл или папку проекта по пути от корня (`@`). */
  onMention(path: string): void;
  /** Пути проекта для `@`; null — список ещё не собирали. */
  mentionPaths(): readonly string[] | null;
  /** Попросить собрать список путей (зовётся, когда он ещё пуст). */
  requestMentions(): void;
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

  /** Контекст одним списком: пункты `#` и выбор изображения из файла. */
  function contextItems(): ComposerItem[] {
    return [
      ...CONTEXT_COMMANDS.map((item) => ({
        title: item.title,
        hint: item.hint,
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
      show(
        SLASH_COMMANDS.filter((item) => item.id.slice(1).startsWith(query)).map((item) => ({
          title: `${item.id} — ${item.title}`,
          hint: item.hint,
          run: () => {
            deps.input.value = item.prompt;
            deps.onAttachBest();
            sync();
            deps.input.focus();
          },
        })),
      );
      return;
    }

    const hash = value.lastIndexOf('#');
    if (hash >= 0 && /(^|\s)#[\w-]*$/.test(value)) {
      const query = value.slice(hash + 1).toLowerCase();
      show(
        CONTEXT_COMMANDS.filter((item) => item.id.slice(1).startsWith(query)).map((item) => ({
          title: `${item.id} — ${item.title}`,
          hint: item.hint,
          run: () => {
            // Убираем набранный `#…`: он был только способом открыть список.
            deps.input.value = `${value.slice(0, hash).trimEnd()} `.trimStart();
            deps.onContext(item.kind);
            deps.input.focus();
          },
        })),
      );
      return;
    }

    // `@` — файл или папка проекта: так контекст прикладывается точнее всего.
    const at = value.lastIndexOf('@');
    if (at >= 0 && /(^|\s)@[\w./-]*$/.test(value)) {
      const query = value.slice(at + 1).toLowerCase();
      const paths = deps.mentionPaths();
      const candidates = (paths ?? []).filter((path) => path.toLowerCase().includes(query)).slice(0, 30);
      if (candidates.length === 0 && paths === null) deps.requestMentions();
      show(
        candidates.map((path) => {
          const isDir = path.endsWith('/');
          return {
            title: path,
            hint: isDir ? 'папка — список файлов' : 'файл — содержимое',
            run: () => {
              deps.input.value = `${value.slice(0, at).trimEnd()} `.trimStart();
              deps.onMention(path);
              deps.input.focus();
            },
          };
        }),
      );
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
