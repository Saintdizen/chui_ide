/**
 * Сценарии файловых действий по шагам: что запомнить до диска, что закрыть,
 * что вернуть при отмене.
 *
 * Каждый шаг здесь — вопрос, на который нельзя ответить «потом»: старое имя нужно,
 * пока файл не переехал; вкладку надо закрыть до `fs.rename`, иначе редактор держит
 * файл за прежний дескриптор; откат переноса идёт в обратном порядке.
 *
 * Операции с диском сюда не входят — модуль только помнит порядок.
 */

import { basename } from '../ui/dom';

/** Что известно про переименование до и после операции с диском. */
export interface RenamePlan {
  /** Переименовываемый путь. */
  readonly from: string;
  /** Его вкладка была активной — вернуть её на экран после переезда. */
  readonly wasActive: boolean;
  /** Вкладка была открыта и её нужно закрыть до `rename`. */
  readonly hadTab: boolean;
}

/**
 * Что запомнить перед переименованием.
 *
 * Активность проверяем ДО закрытия вкладки: после `close` активной станет соседняя,
 * и `wasActive` вышло бы всегда false — переименованный файл открывался бы, но
 * переставал быть на экране.
 */
export function prepareRename(from: string, activePath: string | null, hasTab: boolean): RenamePlan {
  return { from, wasActive: activePath === from, hadTab: hasTab };
}

/** Куда переименовывать при отмене: ровно туда, откуда пришли. */
export function undoRenamePlan(done: { from: string; to: string; touched: number }): {
  from: string;
  to: string;
  restoreImports: boolean;
} {
  return { from: done.to, to: done.from, restoreImports: done.touched > 0 };
}

/** Подпись отмены переименования: старое имя, которое вернётся человеку. */
export function renameUndoLabel(done: { from: string }): string {
  return `Вернуть ${basename(done.from)}`;
}

/**
 * Шаги переноса: каждый — со своим флагом активности.
 *
 * Активность снимаем тоже ДО закрытия вкладки, по той же причине, что и в
 * переименовании: после `close` вопроса «был ли он на экране» уже нет.
 */
export interface MoveTrack {
  readonly from: string;
  readonly to: string;
  readonly active: boolean;
}

export function trackMove(from: string, to: string, activePath: string | null): MoveTrack {
  return { from, to, active: activePath === from };
}

/** Обратные шаги: последний переехавший возвращается первым, и каждое ребро — наоборот. */
export function undoMoves(moved: readonly MoveTrack[]): MoveTrack[] {
  return moved
    .slice()
    .reverse()
    .map((step) => ({ from: step.to, to: step.from, active: step.active }));
}
