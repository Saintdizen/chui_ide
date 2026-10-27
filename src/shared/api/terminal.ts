import type { BookmarkRecord } from '../bookmarks';
import type { FileLabelRecord } from '../file-labels';
import type { DebugExceptionFilters, DebugLaunchOptions } from './debug';

/* ── Терминал ───────────────────────────────────────────────────────────── */

export interface TerminalSession {
  id: string;
  title: string;
  cwd: string;
  shell: string;
  pid: number;
}

export interface TerminalCreateOptions {
  cols: number;
  rows: number;
  cwd?: string;
}

/**
 * Сессия рабочей папки: что было открыто в прошлый раз. Восстанавливается
 * при открытии проекта, чтобы не собирать рабочее место заново.
 */
export interface SessionState {
  /** Абсолютные пути открытых вкладок в порядке слева направо. */
  tabs: string[];
  /** Активная вкладка — если она ещё входит в `tabs`. */
  activeTab?: string;
  /** Абсолютные пути раскрытых папок дерева. */
  expanded: string[];
  /** Закреплённые в дереве файлы и папки: показываются блоком сверху. */
  pinned?: string[];
  /**
   * Корни рабочей области (когда папок в окне несколько): первый — активный.
   * Хранится, чтобы рабочая область из нескольких папок пережила перезапуск.
   */
  roots?: string[];
  /** Какая вкладка нижней панели открыта: `terminal`, `search`, `git`. */
  dockActive?: string;
  /** Параметры запуска отладки: аргументы, окружение и рабочий каталог. */
  debugLaunch?: DebugLaunchOptions;
  /** Наблюдаемые в панели отладки выражения. */
  debugWatch?: string[];
  /** Останов по исключению: какие исключения останавливали программу. */
  debugExceptions?: DebugExceptionFilters;
  /** Точки останова отладки по файлам — их рабочее место помнит для проекта. */
  breakpoints?: BreakpointRecord[];
  /** Закладки: строки файлов, к которым человек возвращается. */
  bookmarks?: BookmarkRecord[];
  /** Метки файлов в дереве: цветные ярлыки («в работе», «срочно»). */
  labels?: FileLabelRecord[];
  /** Где стоял курсор в каждом открытом файле (1-based). */
  cursors?: Record<string, CursorPosition>;
  /** Записанный макрос: шаги записывает и разбирает редактор (`shared/macro.ts`). */
  macro?: unknown[];
  /**
   * Несохранённые правки: текст буферов, которые человек не успел сохранить
   * («hot exit»). При следующем открытии проекта они возвращаются как есть —
   * файл на диске при этом не трогается.
   */
  unsaved?: UnsavedBuffer[];
}

/** Текст несохранённого буфера: путь файла и правленое содержимое. */
export interface UnsavedBuffer {
  path: string;
  text: string;
}

/** Позиция курсора в файле (1-based) - как её считает редактор. */
export interface CursorPosition {
  line: number;
  column: number;
}

/**
 * Точка останова в сессии проекта: файл, строка и её настройки. Похожа на
 * `DebugBreakpoint`, но без `verified`: подтверждает точку отладчик, а в сессии
 * хранится только то, что задал человек.
 */
export interface BreakpointRecord {
  /** Абсолютный путь файла. */
  path: string;
  line: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

/** Полезная нагрузка события `PushTopic.WorkspaceChanged`. */
export interface WorkspaceChangedPayload {
  /** Корень рабочей папки — он же ключ, по которому событие адресуется. */
  root: string;
  /** Что именно изменилось: путь файла или папки. */
  path: string;
  /**
   * Изменилось сразу много файлов, а не один: переключение ветки, `git stash pop`,
   * `merge`, массовое форматирование, правка агентом по всему проекту. Тогда `path` —
   * это корень, а не конкретный файл, и потребителю нужен общий пересчёт, а не
   * точечный: одного пути из потока событий недостаточно (остальные потерялись бы).
   */
  many?: boolean;
}

/** Полезная нагрузка события `PushTopic.TerminalData`. */
export interface TerminalDataPayload {
  id: string;
  data: string;
}

/** Полезная нагрузка события `PushTopic.TerminalExit`. */
export interface TerminalExitPayload {
  id: string;
  exitCode: number;
  signal?: number;
}

/**
 * Прямоугольник области страницы в координатах окна.
 *
 * Вложение рисует не DOM, а сам Chromium отдельным слоем окна, поэтому его место
 * задаётся числами: renderer меряет область редактора и присылает сюда результат.
 */
export interface BrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Состояние вкладки встроенного браузера: то, чем живёт адресная строка и кнопки. */
export interface BrowserNavState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /**
   * Масштаб страницы: 1 — 100 %. Не часть адреса, а состояние вкладки: оно живёт
   * в самом вложении и меняется кнопками шапки, Ctrl+колесом и агентом.
   */
  zoom: number;
  /** Причина неудачи загрузки — показывается человеком словами, а не кодом. */
  error?: string;
}

/** Как менять масштаб страницы: шаг туда-обратно, вписать по ширине или 1:1. */
export type BrowserZoomMode = 'in' | 'out' | 'fit' | 'actual';

/**
 * Элемент страницы, выбранный мышью для вопроса в чате.
 *
 * Собирается на самой странице (см. `panel.ts`): в renderer'е нет ни доступа к
 * DOM гостя, ни возможности что-то в нём подсветить — страница лежит отдельным
 * слоем окна. Поэтому всё, что можно сказать об элементе, приходит готовым.
 */
export interface BrowserPickedElement {
  /** Имя тега маленькими буквами: `button`, `input`, `div`. */
  tag: string;
  /** Путь до элемента: `main.form > input#email`. Короткий, но однозначный. */
  selector: string;
  /** Что написано на элементе или в его `aria-label`: подпись для чипа в чате. */
  name: string;
  /** Роль из `role`; пусто — роль выводится из тега. */
  role: string;
  /** Видимый текст элемента (обрезанный). */
  text: string;
  /** Разметка элемента (обрезанная): без неё непонятно, как он устроен. */
  html: string;
  /** Значимые вычисленные стили: то, что обычно и правят в вёрстке. */
  styles: Record<string, string>;
  /** Где он на странице (в CSS-пикселях, до масштаба). */
  rect: BrowserRect;
}

/**
 * Полезная нагрузка события `PushTopic.BrowserNav`: вложение сообщило о себе.
 *
 * Виды разные по смыслу, а не по оттенку одного: состояние вкладки, просьба
 * страницы о новой вкладке, страница, которую открыл агент, закрытие и общий
 * доступ. Объединять их в один объект с необязательными полями значило бы
 * заставлять renderer угадывать смысл события по тому, какие поля оказались
 * заполнены.
 */
export type BrowserEventPayload =
  /** Состояние активной вкладки: им живут адресная строка и кнопки. */
  | ({ kind: 'state'; id: string } & BrowserNavState)
  /** Страница просит новую вкладку (`_blank`, `window.open`): вторых окон у нас нет. */
  | { kind: 'newTab'; id: string; url: string }
  /** Страницу открыл агент: вкладку заводит renderer, а ключ вкладки дал main. */
  | { kind: 'opened'; id: string; url: string }
  /** Агент закончил работу — вкладку убираем вместе с вложением. */
  | { kind: 'closed'; id: string }
  /** Человек поделился вкладкой с ассистентом: агент работает в этой же странице. */
  | { kind: 'shared'; id: string }
  /** Общий доступ снят (отозван или вкладка закрыта): агент снова заводит свою. */
  | { kind: 'unshared'; id: string }
  /**
   * Агент действует на вкладке: нажал, ввёл текст, выполнил скрипт, открыл адрес.
   * Человек должен видеть, что страница под его руками живёт не только от него.
   */
  | { kind: 'agent'; id: string; action: string };

/** Действие над вкладкой браузера, которое renderer просит выполнить main. */
export type BrowserAction = 'back' | 'forward' | 'reload' | 'stop' | 'navigate' | 'devtools';
