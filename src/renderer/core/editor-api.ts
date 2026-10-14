/**
 * Что редактор умеет для тех, кто им пользуется снаружи.
 *
 * Ассистент, сессия проекта, проверка импортов и переходы работают с редактором
 * через этот интерфейс, а не через класс: раньше это был `EditorService` на Monaco,
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
import type { BreakpointInput } from './debug';
import type { TextDocument } from './document';

export interface EditorApi {
  /** Открыть файл в активной панели. */
  open(document: TextDocument): void;
  /** Применить правки извне (ассистент, языковой сервер). Возврат — что применилось. */
  applyEdits(document: TextDocument, edits: readonly TextEdit[]): unknown;
  /** Позиции курсоров по файлам — их берёт сессия проекта. */
  cursorPositions(): Record<string, CursorPosition>;
  /** Раздать позиции курсоров: панели подхватят их при открытии файла. */
  restoreCursorPositions(positions: Record<string, CursorPosition>): void;
  /** Перейти к строке и столбцу, показывая это место. */
  reveal(path: string, line: number, column: number): void;
  /** Текст выделенного участка. Пустая строка, если выделения нет. */
  selectedText(): string;
  /** Вставка текста в курсор активной панели. */
  insertAtCursor(text: string): boolean;
  /** Файл активной панели (`null` — панель пуста). */
  readonly currentPath: string | null;
  /** Список пометок языка — их видит агент (`get_diagnostics`). */
  markers(path?: string): DiagnosticItem[];
  /** Пометки одного источника (языковой сервер, проверка импортов). */
  setExternalMarkers(path: string, owner: string, diagnostics: readonly LspDiagnostic[]): void;
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
