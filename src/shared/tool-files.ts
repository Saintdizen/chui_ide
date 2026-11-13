/**
 * Файлы, которых коснулся вызов агента: разбор для ленты чата.
 *
 * Модуль чистый — здесь нет DOM, поэтому его проверяют юнит-тесты, а не проба
 * живого окна. Пользуются им двое: сводка группы вызовов считает по нему число
 * тронутых файлов (`ui/chat-tools.ts`), а панель изменений композера берёт
 * подписи видов операции (`ui/chat-changes.ts`).
 */

import type { ToolFileChange } from './api';

/** Вид операции. `edited` — правка через `edit`: своего вида у неё нет. */
export type ChangeKind = ToolFileChange['kind'] | 'edited';

/** Файл, которого коснулся вызов: путь и что с ним сделали. */
export interface TouchedFile {
  path: string;
  kind: ChangeKind;
}

/** Прочитанный файл — источник ответа. Границы нужны для подписи `путь:12-40`. */
export interface ReadFile {
  path: string;
  from?: number;
  to?: number;
}

/** Справка «на чём основан ответ»: источники по ходам истории. */
export interface UsedReferences {
  /** Каждый файл один раз, в порядке первого упоминания. */
  files: ReadFile[];
  /** Сколько чтений не влезло в список (0 — все на месте). */
  omitted: number;
}

/**
 * Источники ответа: все файлы, что модель прочитала за прогон.
 *
 * Считаем по `toolCalls` истории, а не по результатам инструментов: результат
 * живёт в беседе до первого сжатия, а справка нужна и после перезапуска. Файл,
 * прочитанный дважды (весь и куском), остаётся одним: в справке нужен список
 * источников, а не журнал обращений. Границы берём от первого чтения с ними.
 *
 * Потолок — чтобы справка не выросла в простыню на длинном прогоне; сколько
 * не влезло, называется числом, а не обрезается молча.
 */
export function usedReferences(
  messages: readonly { role: string; toolCalls?: readonly { name: string; arguments: string }[] }[],
  limit = 8,
): UsedReferences {
  const files: ReadFile[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      for (const file of readFiles(call.name, call.arguments)) {
        if (seen.has(file.path)) continue;
        seen.add(file.path);
        files.push(file);
      }
    }
  }

  const shown = files.slice(0, Math.max(0, limit));
  return { files: shown, omitted: files.length - shown.length };
}

/** Вид операции человеческим словом: одни и те же слова в ленте и в панели. */
export function changeKindLabel(kind: ChangeKind): string {
  if (kind === 'created') return 'создан';
  if (kind === 'deleted') return 'удалён';
  if (kind === 'moved') return 'перенос';
  if (kind === 'modified') return 'заменено';
  return 'правка';
}

/**
 * Вид изменения по действию слитого инструмента `file`. `copy` — тоже «создан»:
 * рядом с исходником появился файл. `create` в таблице не было уже давно — файл
 * создают через `edit`, но старые беседы его помнят, поэтому `create` остаётся.
 */
const FILE_KINDS: Record<string, ChangeKind> = {
  create: 'created',
  copy: 'created',
  delete: 'deleted',
  move: 'moved',
};

/** Имя файла без пути: пути приходят и с `/`, и с `\`. */
export function fileName(target: string): string {
  const parts = target.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? target;
}

/**
 * Файлы, которые вызов прочитал: путь и необязательные строки диапазона.
 *
 * Отдельно от `touchedFiles`: там про изменения, здесь про источники ответа.
 * Смысл тот же — вытащить пути из аргументов, а не из результата: результат
 * инструмента живёт в беседе до первого сжатия, а справка «на чём основан
 * ответ» должна читаться и после перезапуска.
 *
 * `paths` — пачечное чтение (`read` умеет 2-5 файлов за шаг), `path` —
 * один. Границы — только если они есть в аргументах и файл один: без них
 * подпись просто путь.
 */
export function readFiles(name: string, args: string): ReadFile[] {
  if (name !== 'read') return [];

  try {
    const value = JSON.parse(args) as { path?: unknown; paths?: unknown; startLine?: unknown; endLine?: unknown };
    const single = typeof value.path === 'string' && value.path ? [value.path] : [];
    const batch = Array.isArray(value.paths)
      ? value.paths.filter((path): path is string => typeof path === 'string' && !!path)
      : [];
    // Границы — только для одиночного чтения: при `paths` те же `startLine`
    // относятся к каждому файлу по-разному или не относятся вовсе, и подписать
    // все одним диапазоном значило бы соврать.
    const ranged = batch.length === 0;
    const from = ranged && typeof value.startLine === 'number' ? value.startLine : undefined;
    const to = ranged && typeof value.endLine === 'number' ? value.endLine : undefined;
    // Пути принимаем в одном виде, повторы убираем: `paths` может повторить
    // `path`, а в справке один файл должен быть один раз.
    return [...new Set([...single, ...batch])].map((path) => ({ path, from, to }));
  } catch {
    return [];
  }
}

/**
 * Файлы, которых коснулся вызов. Инструмент возвращает их в `changes`
 * (создание, удаление, перенос, замена по проекту). У `edit` такого списка
 * нет — файлы берём из аргументов: иначе правки не видны и после перезапуска,
 * когда результата инструмента в беседе уже нет.
 */
export function touchedFiles(name: string, args: string, changes?: readonly ToolFileChange[]): TouchedFile[] {
  if (changes?.length) return changes.map((change) => ({ path: change.path, kind: change.kind }));

  if (name !== 'edit' && name !== 'file') return [];

  try {
    const value = JSON.parse(args) as {
      action?: unknown;
      path?: unknown;
      to?: unknown;
      edits?: unknown;
      patches?: unknown;
    };
    const kind: ChangeKind | undefined = name === 'edit' ? 'edited' : FILE_KINDS[String(value.action)];
    if (!kind) return [];
    // У переноса и копии файл — в `to`: `path` в их аргументах и не значится.
    const single = value.action === 'move' || value.action === 'copy' ? value.to : value.path;
    // `edit` правит пачкой, и форма зависит от действия: по якорю файлы лежат в
    // `patches[].path`, по позициям — в `edits[].path`. Один файл может
    // встретиться дважды — в ряду он должен быть один раз.
    const batch = Array.isArray(value.edits) ? value.edits : value.patches;
    const raw = Array.isArray(batch)
      ? batch.map((file) => (file && typeof file === 'object' ? (file as { path?: unknown }).path : undefined))
      : [single];
    const paths = raw.filter((path): path is string => typeof path === 'string' && !!path);
    return [...new Set(paths)].map((path) => ({ path, kind }));
  } catch {
    return []; // аргументы не разобрались — это не повод ломать ленту
  }
}
