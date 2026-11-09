/**
 * Что редактор умеет для тех, кто им пользуется снаружи.
 *
 * Ассистент, сессия проекта, проверка импортов и переходы работают с редактором
 * через этот интерфейс, а не через класс: раньше это был чужой редактор,
 * теперь — своё рабочее место (`EditorWorkspace`). Имена методов и событий у обоих
 * совпадали намеренно, чтобы подмена была незаметной; интерфейс эту договорённость
 * делает явной и убирает зависимость потребителей от конкретного класса.
 *
 * Здесь только то, что действительно нужно снаружи: открыть файл, применить правки,
 * курсоры, переход, выделение и пометки. Ввод, подсветка и попапы — внутреннее дело
 * редактора, снаружи их не видно.
 */

import type { CursorPosition, DiagnosticItem, LspDiagnostic } from '../../shared/api';
import type { TextEdit } from '../../shared/edits';
import type { MacroStep } from '../editor/input/macro';
import type { TranslatedEdits } from '../editor/host/document-edits';
import type { BreakpointInput } from './debug';
import type { EditSource, TextDocument } from './document';

export interface EditorApi {
  /** Открыть файл в активной панели. */
  open(document: TextDocument): void;
  /**
   * Применить правки извне (ассистент, языковой сервер). Возврат — что применилось:
   * редактор сам решает, какие правки годятся, — по его ответу видно, что пропало.
   */
  applyEdits(document: TextDocument, edits: readonly TextEdit[], source?: EditSource): TranslatedEdits;
  /**
   * Сухой прогон: что дало бы `applyEdits`, НЕ трогая текст и историю отмены.
   * Нужен для атомарности пачки правок: сперва узнать, что всё сойдётся, и лишь
   * потом применять — иначе половина файлов уже правлена, а половина отказала.
   * Необязателен: без него `applyFileEdits` идёт старым путём (по файлу за раз).
   */
  previewEdits?(document: TextDocument, edits: readonly TextEdit[]): TranslatedEdits;
  /** Позиции курсоров по файлам — их берёт сессия проекта. */
  cursorPositions(): Record<string, CursorPosition>;
  /** Раздать позиции курсоров: панели подхватят их при открытии файла. */
  restoreCursorPositions(positions: Record<string, CursorPosition>): void;
  /** Верхние строки открытых файлов (с 1) — их тоже берёт сессия проекта. */
  scrollPositions(): Record<string, number>;
  /** Раздать верхние строки: панель встанет туда при открытии файла. */
  restoreScrollPositions(positions: Record<string, number>): void;
  /** Какие блоки свёрнуты в каждом файле — для сессии. */
  foldPositions(): Record<string, number[]>;
  /** Вернуть свёрнутое из сессии. */
  restoreFoldPositions(positions: Record<string, readonly number[]>): void;
  /** Перейти к строке и столбцу, показывая это место. */
  reveal(path: string, line: number, column: number): void;
  /** Текст выделенного участка. Пустая строка, если выделения нет. */
  selectedText(): string;
  /** Вставка текста в курсор активной панели. */
  insertAtCursor(text: string): boolean;
  /** Файл активной панели (`null` — панель пуста). */
  readonly currentPath: string | null;
  /** Список пометок языка — их видит агент (`get_diagnostics`); `under` — папка. */
  markers(path?: string, under?: string): DiagnosticItem[];
  /** Текст открытого документа (несохранённый — из буфера); `null` — файл не открыт. */
  documentText(path: string): string | null;
  /** Пометки одного источника (языковой сервер, проверка импортов). */
  setExternalMarkers(path: string, owner: string, diagnostics: readonly LspDiagnostic[]): void;
  /**
   * Снять пометки указанных источников со всех файлов, где они есть.
   *
   * Нужно тому, кто знает, что источник больше не пришлёт новых показаний: языковой
   * сервер упал и не перезапустится. Без этого старые ошибки висят на экране
   * как живые — проверить их уже некому.
   */
  clearExternalMarkers(owners: readonly string[]): void;
  /** Пометки языка файла с диапазонами — контекст для быстрых исправлений. */
  lspDiagnostics(path: string): LspDiagnostic[];
  /** Где каретка в системе окна (`null` — ничего не открыто): приложение ставит там попапы. */
  caretPoint(): { left: number; top: number; bottom: number } | null;
  /** Точки останова файла: строка и, если задано, условие останова. */
  setBreakpoints(path: string, breakpoints: readonly BreakpointInput[]): void;
  /** Строки закладок файла: их рисует поле значков (список ведёт приложение). */
  setBookmarks(path: string, lines: readonly number[]): void;
  /** Идёт ли запись макроса — по этому приложение показывает это в строке состояния. */
  isRecordingMacro(): boolean;
  /** Записанные шаги макроса: сколько действий повторит «выполнить макрос». */
  macroSteps(): readonly MacroStep[];
  startMacro(): void;
  stopMacro(): readonly MacroStep[];
  playMacro(steps?: readonly MacroStep[]): number;
  restoreMacro(steps: readonly MacroStep[]): void;
}
