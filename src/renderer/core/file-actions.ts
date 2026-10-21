/**
 * Сценарии файловых действий по шагам: что запомнить до диска, что закрыть,
 * что вернуть при отмене.
 *
 * Каждый шаг здесь — вопрос, на который нельзя ответить «потом»: старое имя нужно,
 * пока файл не переехал; вкладку надо закрыть до `fs.rename`, иначе редактор держит
 * файл за прежний дескриптор; откат пачки идёт в обратном порядке.
 *
 * Изменения диска — у вызывающего, в app.ts; здесь только порядок.
 */

import { basename } from '../ui/dom';
import type { MoveStep } from './tree-move';

/**
 * Что сделать с вкладками перед `git.discard`.
 *
 * `discard` возвращает рабочие файлы к коммиту, а новые (untracked) удаляет с диска.
 * Но редактор об этом не знает: у удалённого файла остаётся вкладка с его текстом.
 * Сохранить её поверх — значит воскресить файл, который только что выбросили; открыть
 * заново нельзя — файла нет. Поэтому убираем вкладки ДО обращения к git, а не после.
 *
 * Активность помним заранее — по той же причине, что и в `prepareRename`.
 */
export interface DiscardPlan {
  /** Пути, чьи вкладки надо закрыть перед откатом. */
  readonly close: readonly string[];
  /** На экране был один из них — вернуть его на экран после отката. */
  readonly wasActive: boolean;
  /** Какой именно был на экране: `null`, если ни один. */
  readonly activePath: string | null;
}

export function prepareDiscard(
  paths: readonly string[],
  activePath: string | null,
  hasTab: (path: string) => boolean,
): DiscardPlan {
  const active = activePath !== null && paths.includes(activePath) ? activePath : null;
  return {
    // Закрываем только открытые: `close` на неоткрытый файл безвреден, но в пачке
    // из сотни путей таких большинство — лишние вызовы на пустом месте.
    close: paths.filter((path) => hasTab(path)),
    // Путь и флаг говорят одно и то же для разных читателей: флаг — ответ «да/нет»,
    // путь — то, что идут открывать обратно.
    wasActive: active !== null,
    activePath: active,
  };
}

/**
 * Можно ли приступать к коммиту и что для этого надо сохранить.
 *
 * Git смотрит рабочее дерево, а не экран: правки в буфере в коммит не попадают,
 * пока не сохранены. Сохранять — настройка, но у неё есть исключение, которое
 * выключением не отменяется: файл только для чтения сохранить нельзя — и тогда
 * он попадает в `blocked`, чтобы коммит не ушёл по устаревшему содержимому.
 *
 * Содержимое буфера здесь не трогаем: сохранение — дело вызывающего.
 */
export interface CommitSavePlan {
  readonly save: readonly string[];
  readonly blocked: readonly string[];
}

export function planCommitSave(
  dirty: readonly { readonly path: string; readonly readOnly: boolean }[],
  saveBeforeCommit: boolean,
): CommitSavePlan {
  if (!saveBeforeCommit) return { save: [], blocked: [] };
  return {
    save: dirty.filter((document) => !document.readOnly).map((document) => document.path),
    blocked: dirty.filter((document) => document.readOnly).map((document) => document.path),
  };
}

/**
 * Можно ли предлагать отмену отката правок.
 *
 * Нельзя: `git.discard` перезаписывает рабочее дерево из индекса, а новых файлов
 * просто удаляет с диска. Копии у нас нет, вернуть правки нечем — и обещать нельзя.
 */
export function canUndoDiscard(): boolean {
  return false;
}

/**
 * В индексе пусто, но правки есть — индексировать всё или отказывать.
 *
 * Спрашиваем, а не решаем молча: пустой индекс — либо забыли `git add`, либо нарочно
 * коммитят часть правок. Ответ зависит от того, есть ли вообще что индексировать.
 */
export type CommitStagePlan = 'commit' | 'ask' | 'nothing';

export function planCommitStage(staged: number, unstaged: number): CommitStagePlan {
  if (staged > 0) return 'commit';
  if (unstaged > 0) return 'ask';
  return 'nothing';
}

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
 * Что сказать перед amend.
 *
 * Аменд перезаписывает последний коммит — и вместе с ним сообщение, если передали
 * новое. Это перезапись опубликованной истории, и об этом человек должен знать до,
 * а не узнать из `git log` после. Новое сообщение — `replaced`; уже отправленный
 * коммит — `pushed`. Предупреждать надо про оба, и по-разному.
 */
export type AmendPlan = { readonly kind: 'no-head' } | { readonly kind: 'commit'; readonly warn: boolean };

export function planAmend(head: string | null, replaced: boolean): AmendPlan {
  if (head === null) return { kind: 'no-head' };
  return { kind: 'commit', warn: replaced };
}

/**
 * Объяснение к amend: чем он опасен именно сейчас.
 *
 * `pushed` — последний коммит уже есть на удалённой ветке. Перезапись такой истории
 * требует force-push и ломает копии у всех остальных. Это отдельный текст от
 * «сообщение меняется», и спрашивать надо про оба.
 */
export function amendWarning(replaced: boolean, pushed: boolean): string | null {
  if (replaced && pushed) return 'Сообщение изменится, а коммит уже отправлен: понадобится force-push';
  if (replaced) return 'Сообщение последнего коммита будет заменено';
  if (pushed) return 'Коммит уже отправлен: правка перепишет опубликованную историю';
  return null;
}

/**
 * Переключение ветки при несохранённых буферах.
 *
 * `git checkout` трогает рабочее дерево, а не экран: несохранённые правки он не
 * видит вовсе. Если такой файл в целевой ветке отличается, git либо молча перенесёт
 * правку, либо откажется; в обоих случаях человек ждал не этого. А если буфер
 * открыт и отличается от диска, после переключения на экране останется текст
 * чужой ветки — то самое «всё пропало», которое потом не воспроизвести.
 *
 * Поэтому: `save` — что сохранить до checkout (иначе диск устарел), `ask` — есть
 * что сохранить, но настройка сохранять запрещает: тогда спрашиваем.
 * `blocked` — файлы «только чтение»: их не сохранить, и переключение идёт по
 * старому содержимому.
 */
export interface CheckoutPlan {
  readonly save: readonly string[];
  readonly ask: boolean;
  readonly blocked: readonly string[];
}

export function planCheckout(
  dirty: readonly { readonly path: string; readonly readOnly: boolean }[],
  saveBeforeCheckout: boolean,
): CheckoutPlan {
  if (dirty.length === 0) return { save: [], ask: false, blocked: [] };
  const writable = dirty.filter((document) => !document.readOnly).map((document) => document.path);
  const blocked = dirty.filter((document) => document.readOnly).map((document) => document.path);
  if (!saveBeforeCheckout) return { save: [], ask: writable.length > 0, blocked };
  return { save: writable, ask: false, blocked };
}

/**
 * Что делать перед push.
 *
 * Три случая, и они разные по смыслу:
 *
 * - `nothing` — отправлять нечего (нет коммитов впереди и ветка уже знает upstream).
 *   Отдельно от `push`: «push: Everything up-to-date» — не ошибка, но и не действие;
 *   лучше сказать это самим, чем гонять сеть.
 * - `rejected` — на удалённой ветке есть чужие коммиты: git откажет без
 *   не-fast-forward. Лечится pull, а не force: чужая работа не должна погибнуть
 *   ради нашей.
 * - `push` — обычный случай, в том числе перв ая отправка новой ветки.
 *
 * `force` не выводится отсюда никогда: это решение человека, а не следствие
 * счётчиков. Иначе `--force-with-lease` стал бы ходом по умолчанию.
 */
export type PushPlan = 'push' | 'nothing' | 'rejected';

export function planPush(ahead: number, behind: number): PushPlan {
  // Чужих коммитов больше — сначала вливаем их, иначе отказ и недоумение.
  if (behind > 0) return 'rejected';
  if (ahead === 0) return 'nothing';
  return 'push';
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
 * Снимок переноса: шаги, у которых надо помнить активность, — до закрытия вкладок.
 *
 * Снимок делается ДО первого `rename`: после переезда пути в `steps` уже не
 * описывают реальность, а `openEditors.active` сместится на соседнюю вкладку.
 */
export function trackMoves(steps: readonly MoveStep[], activePath: string | null): MoveTrack[] {
  return steps.map((step) => trackMove(step.from, step.to, activePath));
}

/**
 * Какие пути уносить в корзину при отмене копирования.
 *
 * Отмена копии — это удаление КОПИИ: исходный объект не трогали. В этом и разница
 * между «отменить копирование» и «отменить перенос» — вернуть копию легко, а
 * исходник после переноса пришлось бы возвращать переносом назад.
 */
export function copiedToTrash(copied: readonly string[]): string[] {
  return copied.slice();
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

/**
 * Сколько объектов предлагать вернуть после группового удаления.
 *
 * Ноль, пока `canUndoTrash()` ложь. Это функция, а не литерал на месте вызова:
 * иначе первая же копия литерала разошлась бы с остальными местами.
 */
export function undoableAfterTrash(removed: number): number {
  return canUndoTrash() ? removed : 0;
}

/** Обратные шаги: последний переехавший возвращается первым, и каждое ребро — наоборот. */
export function undoMoves(moved: readonly MoveTrack[]): MoveTrack[] {
  return moved
    .slice()
    .reverse()
    .map((step) => ({ from: step.to, to: step.from, active: step.active }));
}
