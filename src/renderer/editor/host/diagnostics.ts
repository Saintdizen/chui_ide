/**
 * Пометки языка по файлам: несколько источников на файл, счётчики и события.
 *
 * Прежде пометки хранил сам движок, а «my owner» позволял
 * нескольким источникам не затирать друг друга: языковой сервер, проверка импортов,
 * встроенный TypeScript — каждый клал свой набор, а `getModelMarkers` отдавал
 * объединение. Свой редактор такого не умеет, поэтому объединение делаем сами.
 *
 * Источники на файл держим по имени (`owner`), а не одним списком: когда сервер
 * пересылает свежие пометки, он ЗАМЕНЯЕТ свой набор целиком и не должен трогать
 * чужие. Поэтому здесь «положить набор владельца», а не «добавить пометку».
 *
 * Пометки нужны в трёх местах, и всем — в разной форме:
 *
 *   • представление — волнистым подчёркиванием под участком строки (`forPath`);
 *   • статус-бар — числами «ошибок и предупреждений» по открытым файлам (`problemCounts`);
 *   • агент и чат — списком с путём и источником (`markers`), как их видит инструмент
 *     `get_diagnostics`.
 *
 * Модуль чистый: ни DOM, ни движка. Поэтому его видно в тестах без окна.
 */

import type { DiagnosticItem, LspDiagnostic } from '../../../shared/api';
import { Emitter } from '../../core/events';

export class DiagnosticsStore {
  /** Путь → владелец → пометки. Владельцев на файл бывает несколько. */
  private readonly byPath = new Map<string, Map<string, readonly LspDiagnostic[]>>();
  private readonly emitter = new Emitter<void>();

  /** Пометки изменились — статус-бар пересчитывает счётчики. */
  readonly onDidChange = this.emitter.event;

  /**
   * Заменить набор пометок ОДНОГО владельца. Пустой набор убирает владельца с файла;
   * когда владельцев не остаётся, файл исчезает из таблицы целиком. Так закрытие
   * языкового сервера или снятая проверка импортов не оставляют висящих пометок.
   */
  set(path: string, owner: string, diagnostics: readonly LspDiagnostic[]): void {
    const owners = this.byPath.get(path) ?? new Map<string, readonly LspDiagnostic[]>();
    if (diagnostics.length === 0) owners.delete(owner);
    else owners.set(owner, diagnostics);
    if (owners.size === 0) this.byPath.delete(path);
    else this.byPath.set(path, owners);
    this.emitter.fire();
  }

  /** Пометки файла от ВСЕХ источников, по порядку строк: по ним рисуются подчёркивания. */
  forPath(path: string): LspDiagnostic[] {
    const owners = this.byPath.get(path);
    if (!owners) return [];
    const all: LspDiagnostic[] = [];
    for (const list of owners.values()) all.push(...list);
    return all.sort(byPosition);
  }

  /**
   * Список пометок для наружу (`get_diagnostics`): с путём и источником. Без пути —
   * по всем файлам, что и делает инструмент агента.
   */
  markers(path?: string): DiagnosticItem[] {
    const items: DiagnosticItem[] = [];
    for (const [filePath, owners] of this.byPath) {
      if (path && filePath !== path) continue;
      for (const list of owners.values()) {
        for (const item of list) {
          items.push({
            path: filePath,
            line: item.line,
            column: item.column,
            severity: item.severity,
            message: item.message,
            source: item.source ?? '',
          });
        }
      }
    }
    return items.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
  }

  /**
   * Сколько ошибок и предупреждений. Считаем тем же способом, что и `markers`, поэтому
   * число в статус-баре и список, который видит агент, — всегда про одни и те же пометки.
   */
  problemCounts(): { errors: number; warnings: number } {
    let errors = 0;
    let warnings = 0;
    for (const owners of this.byPath.values()) {
      for (const list of owners.values()) {
        for (const item of list) {
          if (item.severity === 'error') errors += 1;
          else if (item.severity === 'warning') warnings += 1;
        }
      }
    }
    return { errors, warnings };
  }

  /** Файлы, у которых есть пометки. Нужно для «перейти к следующей проблеме». */
  paths(): string[] {
    return [...this.byPath.keys()];
  }

  /** Убрать пометки файла целиком: его закрыли или он ушёл из открытых. */
  clear(path: string): void {
    if (this.byPath.delete(path)) this.emitter.fire();
  }

  /**
   * Забыть ВСЕ пометки — при смене проекта.
   *
   * Отдельно от `clear(path)` потому, что свои пометки снимают сами проверки
   * (`projectCheck`, `typeCheck`), а пометки обхода проекта знает только окно: старый
   * корень закрылся, а обход нового мог и не начаться (в проекте нет сервера) — ошибки
   * чужого кода висели бы в панели «Проблемы» вечно.
   */
  clearAll(): void {
    if (this.byPath.size === 0) return;
    this.byPath.clear();
    this.emitter.fire();
  }

  /** Пометки файла, сгруппированные в порядке следования по документу — для перехода. */
  ordered(path?: string): DiagnosticItem[] {
    return this.markers(path);
  }

  /** Отпустить подписчиков: рабочее место закрывается. */
  dispose(): void {
    this.byPath.clear();
    this.emitter.dispose();
  }
}

/** Порядок пометок в строке: сверху вниз, слева направо. */
function byPosition(a: LspDiagnostic, b: LspDiagnostic): number {
  return a.line - b.line || a.column - b.column;
}
