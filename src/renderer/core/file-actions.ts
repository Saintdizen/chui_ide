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

/**
 * Отмена создания: что закрыть и что вернуть.
 *
 * Отмена созданного файла трогает две вещи, и обе важны по-своему. Закрыть
 * вкладку можно только через команду `file.close`: она же переводит редактор на
 * соседнюю вкладку, а прямой `openEditors.close` оставил бы на экране закрытый файл.
 *
 * Папка вкладок не имеет — для неё шаг один.
 */
export interface CreateUndo {
  /** Закрыть вкладку — только если её открывали. */
  readonly closeTab: boolean;
  /** Путь для `file.close`; null — папку закрывать нечем. */
  readonly closePath: string | null;
  /** Что унести в корзину: и файл, и папка уносятся одним и тем же путём. */
  readonly trashPath: string;
}

/** Отмена создания файла: вкладку открывали всегда (`openPath` в самом сценарии). */
export function createFileUndo(path: string): CreateUndo {
  return { closeTab: true, closePath: path, trashPath: path };
}

/** Отмена создания папки: вкладки у папки нет. */
export function createFolderUndo(path: string): CreateUndo {
  return { closeTab: false, closePath: null, trashPath: path };
}

/**
 * Можно ли предлагать отмену удаления.
 *
 * Нельзя, и это не придирка: `shell.trashItem` — единственный путь удаления, а
 * обратного вызова у него нет. Кнопка «Отменить», которая при нажатии ничего не
 * делает, хуже, чем её отсутствие: человек верит, что файл вернулся.
 * Когда появится восстановление из корзины — здесь станет `true`.
 */
export function canUndoTrash(): boolean {
  return false;
}

/** Обратные шаги: последний переехавший возвращается первым, и каждое ребро — наоборот. */
export function undoMoves(moved: readonly MoveTrack[]): MoveTrack[] {
  return moved
    .slice()
    .reverse()
    .map((step) => ({ from: step.to, to: step.from, active: step.active }));
}
