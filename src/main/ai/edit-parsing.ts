import path from 'node:path';
import type { FileEdit, TextEdit } from '../../shared/edits';
import type { PatchFile, PatchHunk } from '../../shared/patch';
import type { ToolOutcome } from './agent-tools';

/**
 * Разбор и сведение правок: всё, что происходит с аргументом `edit` до самого
 * применения. Отдельно от `agent-tools.ts`, потому что это и самый объёмный,
 * и самый самодостаточный его кусок: на входе строки от модели, на выходе
 * структуры для мостов renderer — ни рабочей папки, ни хостового вызова.
 *
 * Здесь же разбор оболочки вокруг поиска: `grep x | head -5` — это поиск с
 * усечением, а не команда оболочки, и понимать его надо именно так.
 */

/** Максимум правок за один вызов: защита от вырожденного ответа модели. */
export const MAX_EDITED_FILES = 50;
/** И правок внутри одного файла: ответ модели может выродиться и так. */
export const MAX_EDITS_PER_FILE = 500;

/** Форма аргумента правки: её называем в ошибках — вызов чинится за один шаг. */
export const EDITS_SHAPE =
  'нужен [{ path: "/абсолютный/путь/файл", oldText, newText }] — файл и замена в одном элементе; ' +
  'вместо старого текста можно четыре позиции: startLine, startColumn, endLine, endColumn';

/** Найденные правки: по якорю и по позициям — дальше это два разных моста. */
export interface ParsedEdits {
  anchors: PatchFile[];
  positions: FileEdit[];
}

/**
 * Ответы нескольких путей (созданные файлы вместе с правками) — один ответ: шаг
 * у вызова один, и модели нужен один итог, а не три карточки.
 */
export function combineOutcomes(outcomes: ToolOutcome[]): ToolOutcome {
  const [only] = outcomes;
  if (outcomes.length === 1 && only) return only;
  if (outcomes.length === 0) return { ok: false, summary: 'Нечего применять: нет ни одной правки' };
  const changes = outcomes.flatMap((outcome) => outcome.changes ?? []);
  const detail = outcomes
    .map((outcome) => outcome.detail ?? '')
    .filter((text) => text.length > 0)
    .join('\n');
  const ok = outcomes.every((outcome) => outcome.ok !== false);
  return {
    ok,
    summary: outcomes.map((outcome) => outcome.summary).join('; '),
    ...(detail ? { detail } : {}),
    ...(changes.length > 0 ? { changes } : {}),
    ...(ok && outcomes.every((outcome) => outcome.applied === true) ? { applied: true } : {}),
  };
}

/**
 * Разбор аргумента `edit`. Модель — недоверенный источник, поэтому структура
 * проверяется вручную: битая правка дальше в документную модель попасть не
 * должна. Форму выбирает сама правка: все четыре позиции — правка по позициям
 * (`oldText` рядом с ними остаётся сверкой), иначе нужен якорь `oldText`.
 */
export function parseEdits(value: unknown): ParsedEdits {
  // Одиночный файл без обёртки в массив — та же правка: ронять вызов из-за
  // лишних квадратных скобок незачем.
  const single = typeof value === 'object' && value !== null && !Array.isArray(value);
  const list: unknown = single ? [value] : value;
  if (!Array.isArray(list)) throw new Error(`Аргумент «edits» должен быть массивом: ${EDITS_SHAPE}`);
  if (list.length === 0) throw new Error('Не передано ни одной правки');
  if (list.length > MAX_EDITED_FILES) {
    throw new Error(`Слишком много файлов за один вызов: ${list.length} (максимум ${MAX_EDITED_FILES})`);
  }

  const parsed: ParsedEdits = { anchors: [], positions: [] };
  list.forEach((item, index) => {
    const file = parseEditFile(item, index);
    if (file.anchor) parsed.anchors.push(file.anchor);
    if (file.position) parsed.positions.push(file.position);
  });
  return parsed;
}

/** Правка внутри файла: либо якорь, либо диапазон — вместе они не ходят. */
type EditItem = { anchor: PatchHunk } | { position: TextEdit };

/**
 * Якоря, положенные прямо в элемент файла: `{path, oldText, newText}`,
 * `{path, contents}` или их список в `patches`/`hunks`. Пусто — если их нет.
 */
function flatHunks(raw: Record<string, unknown>): unknown {
  for (const key of ['patches', 'hunks']) {
    const list = raw[key];
    if (Array.isArray(list) && list.length > 0) return list;
  }
  const hasAnchor = typeof raw.oldText === 'string' || typeof raw.newText === 'string';
  if (!hasAnchor) return undefined;
  const hunk: Record<string, unknown> = {};
  for (const key of ['oldText', 'newText']) {
    if (raw[key] !== undefined) hunk[key] = raw[key];
  }
  return [hunk];
}

/**
 * Один файл. Якоря и позиции в одном файле — это два разных пути правки (якоря
 * разрешает renderer, позиции применяет документная модель), поэтому файл
 * отдаётся одному из них целиком: смесь чинится разделением вызова.
 */
function parseEditFile(value: unknown, index: number): { anchor?: PatchFile; position?: FileEdit } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`edits[${index}]: ожидался объект — ${EDITS_SHAPE}`);
  }

  const raw = value as Record<string, unknown>;
  const filePath = raw.path;
  // Форму называем прямо: «не задан path» само по себе не говорит, куда его класть.
  // Самая частая ошибка — замена вместо файла: в элементе oldText и newText, а
  // обёртки с путём нет. Об этом и говорим, иначе модель пришлёт то же снова.
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    const inner = Array.isArray(raw.edits) ? raw.edits : [];
    const swap = typeof raw.oldText === 'string' || typeof raw.newText === 'string';
    const whole = inner.some((item) => {
      if (typeof item !== 'object' || item === null) return false;
      const hunk = item as Record<string, unknown>;
      return typeof hunk.newText === 'string' && hunk.oldText === undefined;
    });
    const hint = whole
      ? ' Похоже на запись файла целиком: в элементе нужен `path` рядом с `contents`.'
      : swap
        ? ' В элементе лежат сами замены (oldText/newText), а не файл — добавь `path` рядом.'
        : '';
    throw new Error(`edits[${index}]: не задан path.${hint} ${EDITS_SHAPE}`);
  }
  if (!path.isAbsolute(filePath)) {
    throw new Error(`edits[${index}].path: нужен абсолютный путь, получено «${filePath}»`);
  }

  // Элемент без `edits[]`, но с самим якорем: `{path, oldText, newText}` — та же
  // правка, только на уровень выше. По переписи вызовов это САМАЯ частая ошибка
  // `edit` (11 из 15 отказов): `edits[0].edits` — третья вложенность, о которой
  // никто не догадывается. Разбираем обе раскладки — ошибка стоит шага, а
  // снисходительность — ничего.
  const edits = raw.edits === undefined ? flatHunks(raw) : raw.edits;
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error(`edits[${index}].edits: нужен непустой массив правок. ${EDITS_SHAPE}`);
  }
  if (edits.length > MAX_EDITS_PER_FILE) {
    throw new Error(`edits[${index}].edits: слишком много правок (${edits.length}), максимум ${MAX_EDITS_PER_FILE}`);
  }

  const items = edits.map((edit, editIndex) => parseEditItem(edit, index, editIndex));
  const anchors = items.filter((item): item is { anchor: PatchHunk } => 'anchor' in item);
  const positions = items.filter((item): item is { position: TextEdit } => 'position' in item);

  if (anchors.length > 0 && positions.length > 0) {
    throw new Error(`edits[${index}]: в одном файле и якоря (oldText), и позиции — раздели на два вызова`);
  }
  if (positions.length > 0) {
    const fileEdit: FileEdit = {
      path: filePath,
      edits: positions.map((item) => item.position),
    };
    if (typeof raw.expectedVersion === 'number') fileEdit.expectedVersion = raw.expectedVersion;
    return { position: fileEdit };
  }
  return {
    anchor: { path: filePath, patches: anchors.map((item) => item.anchor) },
  };
}

/** Одна правка: `newText` и адрес — якорь или все четыре позиции. */
function parseEditItem(value: unknown, fileIndex: number, editIndex: number): EditItem {
  const where = `edits[${fileIndex}].edits[${editIndex}]`;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where}: ожидался объект`);
  }

  const raw = value as Record<string, unknown>;
  const newText = raw.newText;
  if (typeof newText !== 'string') throw new Error(`${where}.newText: нужна строка`);

  const oldText = raw.oldText;
  if (oldText !== undefined && typeof oldText !== 'string') throw new Error(`${where}.oldText: нужна строка`);

  const keys = ['startLine', 'startColumn', 'endLine', 'endColumn'] as const;
  const given = keys.filter((key) => raw[key] !== undefined);
  if (given.length === keys.length) {
    const edit: TextEdit = {
      startLine: editPosition(raw, 'startLine', where),
      startColumn: editPosition(raw, 'startColumn', where),
      endLine: editPosition(raw, 'endLine', where),
      endColumn: editPosition(raw, 'endColumn', where),
      newText,
    };
    // Якорь рядом с позициями — сверка, а не адрес: промах по номеру строки
    // тогда просто не пройдёт.
    if (typeof oldText === 'string') edit.oldText = oldText;
    return { position: edit };
  }
  if (given.length > 0) {
    throw new Error(`${where}: позиции заданы не все — нужны startLine, startColumn, endLine, endColumn`);
  }
  if (typeof oldText !== 'string' || oldText.length === 0) {
    // Запись файла целиком приходит без якоря: в переписи это два отказа из
    // двадцати четырёх (`edits[].edits[]` с одним `newText` и без `path`).
    // Без адреса правку не сделать, но модель обычно метила в `create` — говорим.
    const whole = typeof newText === 'string' && newText.includes('\n');
    const hint = whole ? ' Похоже на запись файла целиком: у `create` есть `contents`.' : '';
    throw new Error(`${where}: нужен oldText (якорь) или все четыре позиции.${hint} ${EDITS_SHAPE}`);
  }
  return { anchor: { oldText, newText } };
}

/** Позиция правки: целое число ≥ 1, как в LSP. */
function editPosition(raw: Record<string, unknown>, key: string, where: string): number {
  const number = raw[key];
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
    throw new Error(`${where}.${key}: нужно целое число ≥ 1`);
  }
  return number;
}
