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

/** Вид операции человеческим словом: одни и те же слова в ленте и в панели. */
export function changeKindLabel(kind: ChangeKind): string {
  if (kind === 'created') return 'создан';
  if (kind === 'deleted') return 'удалён';
  if (kind === 'moved') return 'перенос';
  if (kind === 'modified') return 'заменено';
  return 'правка';
}

/** Инструменты, у которых файлы видно только в аргументах вызова. */
const ARGUMENT_KINDS: Record<string, ChangeKind> = {
  edit: 'edited',
  create_file: 'created',
  delete_file: 'deleted',
  move_file: 'moved',
};

/** Имя файла без пути: пути приходят и с `/`, и с `\`. */
export function fileName(target: string): string {
  const parts = target.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? target;
}

/**
 * Файлы, которых коснулся вызов. Инструмент возвращает их в `changes`
 * (создание, удаление, перенос, замена по проекту). У `edit` такого списка
 * нет — файлы берём из аргументов: иначе правки не видны и после перезапуска,
 * когда результата инструмента в беседе уже нет.
 */
export function touchedFiles(name: string, args: string, changes?: readonly ToolFileChange[]): TouchedFile[] {
  if (changes?.length) return changes.map((change) => ({ path: change.path, kind: change.kind }));

  const kind = ARGUMENT_KINDS[name];
  if (!kind) return [];

  try {
    const value = JSON.parse(args) as { path?: unknown; to?: unknown; edits?: unknown; patches?: unknown };
    // У переноса файл — в `to`: `path` в его аргументах и не значится.
    const single = name === 'move_file' ? value.to : value.path;
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
