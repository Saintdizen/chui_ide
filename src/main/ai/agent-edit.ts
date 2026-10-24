/**
 * Правка файлов: разобрать запрос модели, применить и рассказать, что вышло.
 *
 * `edit` — единственный инструмент, который меняет файлы, и вся его середина здесь:
 * `normalizeWrite` приводит к общему виду разные формы правки, `splitWholeWrites`
 * режет большой файл на части, `mergeDecisions` сводит ответы нескольких правок в
 * один, и `editAction` собирает ответ модели. Соседи по `agent-tools.ts` зовут это
 * только через реестр.
 *
 * Перенос без правки поведения: та же логика, другие адреса.
 */
import path from 'node:path';
import type { ApplyEditsHostResult } from '../../shared/api';
import type { ApplyFailure, ApplyReport } from '../../shared/edits';
import type { ParsedEdits } from './edit-parsing';

const MAX_REPLACE_SUMMARY_FILES = 20;
import type { WorkspaceService } from '../workspace/workspace';
import { missingForAction, optionalBoolean, optionalString, requireString } from './tool-args';
import { relative } from './agent-terminal';
import { unknownAction } from './agent-present';
export { editFiles, editAction } from './agent-edit-core';
import type { ToolContext, ToolOutcome } from './tool-context';

/**
 * Разбор ответа renderer о правках: что применилось, что не удалось и что осталось
 * только в буфере редактора.
 *
 * Последнее важно называть вслух: main читает файлы с диска, и без оговорки агент
 * счёл бы незаписанный текст уже применённым — а ошибку нашёл бы не в правке,
 * а в следующем чтении («текст не тот, что я написал»).
 */
export function readEditsOutcome(
  decision: ApplyEditsHostResult,
  label: (file: string) => string,
): {
  applied: ApplyReport[];
  failed: ApplyFailure[];
  tail: string;
  detail: string;
  ok: boolean;
} {
  const applied = decision.result?.reports ?? [];
  const failed = decision.result?.failed ?? [];
  const unwritten = decision.unwritten ?? [];
  const reasons = decision.unwrittenReasons ?? {};
  const lines = [
    ...applied.map((report) => `ok ${label(report.path)}: применено правок — ${report.applied}`),
    ...failed.map((failure) => `ошибка ${label(failure.path)}: ${failure.message}`),
    // Буфер и диск разошлись: правка видна в редакторе, а в файле её нет.
    // Причина называет, что именно чинить: конфликт с диском — перечитать файл,
    // EACCES — права. Без неё агент принимается переделывать саму правку.
    ...unwritten.map((file) => `буфер ${label(file)}: на диск не записано — ${describeUnwritten(reasons[file])}`),
  ];
  return {
    applied,
    failed,
    tail: unwritten.length > 0 ? `, не записано на диск: ${unwritten.length}` : '',
    detail: lines.join('\n') || 'Правки не применены',
    ok: failed.length === 0,
  };
}

export const EDITOR_MISSING: ToolOutcome = {
  ok: false,
  summary: 'Правки сейчас недоступны: окно редактора не подключено',
};

/**
 * `edit` — правка файлов одним инструментом и одной формой входа. Место
 * называется либо якорем (`oldText`: точный фрагмент, единственный в файле),
 * либо четырьмя позициями в стиле LSP; замену несёт `newText`. Адресаций две,
 * потому что первая не может промахнуться, а вторая не требует искать текст
 * вовсе, — но форма входа одна: иначе в каждом запросе ехали бы две схемы.
 *
 * Дальше пути прежние: якоря разрешает renderer (только у него есть текст
 * документа, в том числе несохранённый), позиции применяет документная модель.
 * Ревью, undo и панель изменений у обоих одни и те же.
 */

/**
 * Привести вход правки к одной форме — списку файлов с их заменами.
 *
 * Зачем. По переписи отказов `edit` отказывал не по делу, а по форме: модель
 * присылала ту же правку, только без обёртки `{ path, edits: [...] }` — либо
 * `path` на верхнем уровне, либо `path` в каждом элементе. Каждый такой отказ
 * стоил целого шага, хотя разобрать такую запись можно без догадок: все данные
 * на месте, объявлена не та форма.
 *
 * Поэтому разбор снисходителен к обёрткам и остаётся строгим к самому адресу:
 * нет пути ни в элементе, ни сверху — отказ (там действительно нечего исполнять).
 */
export function normalizeWrite(args: Record<string, unknown>): unknown {
  const top = typeof args.path === 'string' && args.path.trim().length > 0 ? args.path : undefined;
  const raw = args.edits;

  // Обёртки нет совсем: `path` и замена лежат рядом на верхнем уровне.
  if (raw === undefined) {
    if (top && typeof args.contents === 'string') return [{ path: top, edits: [{ newText: args.contents }] }];
    if (top && (typeof args.oldText === 'string' || typeof args.newText === 'string')) {
      const edit: Record<string, unknown> = {
        newText: typeof args.newText === 'string' ? args.newText : '',
      };
      if (typeof args.oldText === 'string') edit.oldText = args.oldText;
      return [{ path: top, edits: [edit] }];
    }
    return raw;
  }

  const list: unknown[] = Array.isArray(raw) ? raw : [raw];
  // Вложенная форма: элементы — файлы. У файла без пути берём верхний.
  if (list.some(hasInnerEdits)) {
    return list.map((item) => {
      if (!isRecord(item)) return item;
      // Замена, положенная рядом с путём (`{path, oldText, newText}`), — тоже файл:
      // объявленная форма `edits` в схеме именно такая. Сворачиваем в `edits[]`,
      // иначе разбор дойдёт до `oldText` как до чужого поля и откажет.
      const hunk = flatHunk(item);
      const file = hasInnerEdits(item) || hunk ? { ...item, edits: item.edits ?? [hunk] } : item;
      return typeof file.path !== 'string' && top ? { ...file, path: top } : file;
    });
  }

  // Плоская форма: элементы — сами замены. Собираем их по путям (свой или верхний).
  const groups = new Map<string, unknown[]>();
  for (const item of list) {
    const itemPath = isRecord(item) && typeof item.path === 'string' ? item.path : top;
    // Путь не найти — не угадываем: пусть отказ назовёт форму (это данные, а не шум).
    if (!itemPath) return list;
    const hunk = isRecord(item) ? flatHunk(item) : null;
    const bucket = groups.get(itemPath) ?? [];
    // Замена во плоской форме (`{path, oldText, newText}` среди замен) — тоже по адресу:
    // иначе до разбора дошёл бы `path` как чужое поле замены, и вызов бы отвалился.
    bucket.push(hunk ?? item);
    groups.set(itemPath, bucket);
  }
  return [...groups.entries()].map(([filePath, edits]) => ({
    path: filePath,
    edits,
  }));
}

/** Элемент правки — файл с вложенными заменами, а не сама замена. */
export function hasInnerEdits(item: unknown): boolean {
  return isRecord(item) && Array.isArray(item.edits);
}

/**
 * Замена, лежащая в самом элементе файла: `{path, oldText, newText}`. Схема `edit`
 * объявляет `edits` массивом, и модель кладёт в него ровно такую запись — путь и
 * замена рядом. Отказ здесь был вторым по частоте («у элемента не нашлось якоря»),
 * хотя в действительности было ясно, что менять и чем.
 */
export function flatHunk(item: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof item.oldText !== 'string' && typeof item.newText !== 'string') return null;
  const hunk: Record<string, unknown> = { newText: typeof item.newText === 'string' ? item.newText : '' };
  if (typeof item.oldText === 'string') hunk.oldText = item.oldText;
  for (const key of ['startLine', 'startColumn', 'endLine', 'endColumn'] as const) {
    if (typeof item[key] === 'number') hunk[key] = item[key];
  }
  return hunk;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Запись файла целиком, найденная среди правок: якоря нет, есть только текст. */
interface WholeWrite {
  path: string;
  contents: string;
}

/**
 * Отделить запись нового файла от правки существующего.
 *
 * `newText` без `oldText` — это не правка, а новый текст файла. Раньше на таком
 * вызове был отказ с подсказкой про `create`; шаг на переписывание тратился,
 * хотя решает не модель, а диск: файла нет — значит запись целиком. Если файл
 * есть — правка без якоря неоднозначна, и отказ с подсказкой остаётся.
 */
export async function splitWholeWrites(
  workspace: WorkspaceService,
  value: unknown,
): Promise<{ files: unknown[]; creates: WholeWrite[] }> {
  if (!Array.isArray(value)) return { files: [], creates: [] };
  const files: unknown[] = [];
  const creates: WholeWrite[] = [];
  for (const item of value) {
    const whole = isRecord(item) ? wholeWrite(item) : null;
    if (!whole || (await pathExists(workspace, whole.path))) {
      files.push(item);
      continue;
    }
    creates.push(whole);
  }
  return { files, creates };
}

/** Файл-элемент, у которого все замены без якоря и без позиций, — запись целиком. */
export function wholeWrite(item: Record<string, unknown>): WholeWrite | null {
  if (typeof item.path !== 'string' || !Array.isArray(item.edits)) return null;
  const parts: string[] = [];
  for (const edit of item.edits) {
    if (!isRecord(edit)) return null;
    const positional = ['startLine', 'startColumn', 'endLine', 'endColumn'].some((key) => edit[key] !== undefined);
    if (positional || typeof edit.oldText === 'string' || typeof edit.newText !== 'string') return null;
    parts.push(edit.newText);
  }
  return parts.length === 0 ? null : { path: item.path, contents: parts.join('\n') };
}

/** Файл на месте и это не каталог. */
export async function pathExists(workspace: WorkspaceService, target: string): Promise<boolean> {
  // `stat` есть не всегда (упрощённый контекст в проверках). Нет его — считаем, что
  // файл есть: угадывать по отсутствию метода нельзя, а отказ с подсказкой безвреден.
  if (typeof workspace.stat !== 'function') return true;
  try {
    await workspace.stat(target);
    return true;
  } catch (error) {
    // Только «не найден» — это «файла нет». Ошибка доступа означает «есть, разбирайся
    // сам»: запись целиком поверх файла, к которому нет доступа, — не наше решение.
    return !isMissing(error);
  }
}

export function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ENOENT') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /ENOENT|не найден|не найдена/i.test(message);
}

/** Сколько строк вокруг правки показывает ответ `edit`. */
export const EDIT_CONTEXT_LINES = 4;

/**
 * Команда в проекте — единственное, что меняет систему за пределами документов,
 * поэтому она всегда идёт через подтверждение. `background: true` — та же команда,
 * но шаг она не держит: возвращается номер задания, а вывод читается действием
 * `output`. Раньше это были три имени (`run_terminal`, `run_output`, `run_stop`),
 * и каждое стоило своей схемы в каждом запросе.
 */

/** Ответы двух мостов — один: отчёт о файлах складывается, «не записано» тоже. */
export function mergeDecisions(decisions: readonly ApplyEditsHostResult[]): ApplyEditsHostResult {
  const [only] = decisions;
  if (decisions.length === 1 && only) return only;
  return {
    rejected: decisions.some((decision) => decision.rejected),
    result: {
      reports: decisions.flatMap((decision) => decision.result?.reports ?? []),
      failed: decisions.flatMap((decision) => decision.result?.failed ?? []),
    },
    unwritten: decisions.flatMap((decision) => decision.unwritten ?? []),
  };
}

/**
 * Почему правка осталась в буфере — короткой фразой, которую агент может сразу
 * переложить в действие. `undefined` — запись не пытались: так бывает без полного
 * доступа, файл сохраняет человек.
 */
export function describeUnwritten(reason: string | undefined): string {
  if (!reason) return 'сохранит человек';
  if (reason === 'conflict') return 'файл изменён на диске, перечитай его перед правкой';
  return `запись не удалась (${reason}), дальше чтение вернёт старый текст`;
}

/**
 * Файлы и папки: создание, перемещение, удаление и замена по проекту меняют диск
 * одинаково. Смысл каждого действия живёт в описаниях его полей (схема — в
 * `shared/tools.ts`), здесь только адрес и порядок.
 */
export async function fileAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = requireString(args, 'action').trim();
  const missing = missingForAction(args, FILE_ARGS[action] ?? []);
  if (missing) return missing;
  // Смысл каждого действия — в его полях, а не в шапке: шапку модель читает один
  // раз, а поле — ровно перед тем, как его заполнить. `contents` у `create` и
  // `replacement` у `replace` путали чаще всего («не задан аргумент contents»
  // приходил на `replace` — модель несла новое содержимое из привычки).
  if (action === 'create') return await createFile(ctx.workspace, args);
  if (action === 'move') return await moveFile(ctx.workspace, args);
  if (action === 'delete') return await deleteFile(ctx.workspace, args);
  if (action === 'replace') return await replaceInFiles(ctx.workspace, args);
  return unknownAction(action, 'file: create, move, delete, replace.');
}

/**

 * Массовая замена по файлам проекта. Идёт в main, как и остальные файловые

 * операции: логика замены чистая (`shared/replace.ts`) и уже проверена.

 * Изменённые файлы возвращаются в `changes` — панель изменений чата их покажет.

 */

export async function replaceInFiles(workspace: WorkspaceService, args: Record<string, unknown>): Promise<ToolOutcome> {
  const query = requireString(args, 'query');

  const isRegex = optionalBoolean(args, 'isRegex') ?? false;

  const glob = optionalString(args, 'glob');

  // Предохранитель после аварии: `.*` без glob прошёлся по всем 1047 файлам и

  // превратил дерево в «x», а откатить это было нечем. Шаблон, который совпадает

  // с пустой строкой (`.`, `.*`, `^`, `\b`), без маски — это не «заменить», это

  // «переписать всё»: сначала маска, потом замена.

  if (isRegex && !glob) {
    let matchesEmpty = false;

    try {
      matchesEmpty = new RegExp(query).test('');
    } catch {
      matchesEmpty = false;
    }

    if (matchesEmpty) {
      return {
        ok: false,

        summary: 'шаблон слишком широкий',

        detail:
          `Регулярка «${query}» совпадает с пустой строкой — под неё попадёт почти весь проект. ` +
          'Сузь её или добавь `glob` (например, `src/**/*.ts`); для одной строки — `edit` с `oldText`.',
      };
    }
  }

  const replacement = typeof args.replacement === 'string' ? args.replacement : '';

  const result = await workspace.replace({
    query,

    replacement,

    isRegex,

    caseSensitive: optionalBoolean(args, 'caseSensitive') ?? false,

    glob,
  });

  if (result.replaced === 0) {
    return {
      ok: true,

      summary: 'ничего не заменено',

      detail: `Вхождений «${query}» не найдено${args.glob ? ` по маске ${args.glob}` : ''}.`,
    };
  }

  const root = workspace.rootPath();

  const shown = result.files.slice(0, MAX_REPLACE_SUMMARY_FILES);

  const lines = shown.map((file) => relative(file, root));

  if (result.files.length > shown.length) lines.push(`… ещё файлов: ${result.files.length - shown.length}`);

  return {
    ok: true,

    summary: `заменено вхождений: ${result.replaced} · файлов: ${result.files.length}`,

    detail: lines.join('\n'),

    changes: result.files.map((file) => ({
      path: file,

      kind: 'modified' as const,

      replaced: result.replaced,
    })),
  };
}

/** Новый файл. Существующий не перетираем — для этого есть правка. */

export async function createFile(workspace: WorkspaceService, args: Record<string, unknown>): Promise<ToolOutcome> {
  const target = requireString(args, 'path');

  // Пустая строка — законное содержимое, а вот отсутствие поля — нет: раньше оно

  // тихо превращалось в пустой файл, и инструмент отчитывался «создан (0 строк)» —

  // опечатка в имени поля давала не ошибку, а пустоту. Отказ называет форму целиком:

  // за «создай a.ts» модель понимает, что нужен `contents`.

  if (typeof args.contents !== 'string') {
    return {
      ok: false,

      summary: 'Не задан аргумент «contents» (содержимое нового файла)',

      detail:
        'Создание файла требует содержимого целиком. Форма: ' +
        '{"action":"create","path":"a/b.ts","contents":"…"}. Пустой файл — "contents":""; ' +
        'менять существующий файл — это edit.',
    };
  }

  const contents = typeof args.contents === 'string' ? args.contents : String(args.contents);

  const created = await workspace.createFile(target, contents);

  const lines = contents.length === 0 ? 0 : contents.split('\n').length;

  return {
    ok: true,

    summary: `создан ${relative(created, workspace.rootPath())} (${lines} строк)`,

    detail: `Создан файл ${created}.`,

    changes: [{ path: created, kind: 'created', lines }],

    // Содержимое уже в файле: в истории его можно заменить пометкой.

    applied: true,
  };
}

/** Удаление только в корзину: безвозвратное rm из IDE — слишком дорогая ошибка. */

export async function deleteFile(workspace: WorkspaceService, args: Record<string, unknown>): Promise<ToolOutcome> {
  const target = requireString(args, 'path');

  await workspace.trash(target);

  return {
    ok: true,

    summary: `в корзину: ${relative(target, workspace.rootPath())}`,

    detail: `Удалено (в корзину): ${target}.`,

    changes: [{ path: target, kind: 'deleted' }],
  };
}

/** Перемещение/переименование. Целевой путь не должен существовать. */

export async function moveFile(workspace: WorkspaceService, args: Record<string, unknown>): Promise<ToolOutcome> {
  const from = requireString(args, 'from');

  const to = requireString(args, 'to');

  const moved = await workspace.rename(from, to);

  const root = workspace.rootPath();

  return {
    ok: true,

    summary: `${relative(from, root)} → ${relative(moved, root)}`,

    detail: `Перемещено: ${from} → ${moved}.`,

    changes: [{ path: moved, kind: 'moved', from }],
  };
}

/**

 * Обязательные поля каждого действия `file`. Их называет не только разбор, но и

 * ответ на опечатку в `action`: модель тогда видит, каких аргументов не хватало.

 */

const FILE_ARGS: Record<string, readonly string[]> = {
  create: ['path', 'contents'],

  move: ['from', 'to'],

  delete: ['path'],

  replace: ['query', 'replacement'],
};

/**
 * Окно строк вокруг каждой правки: `EDIT_CONTEXT_LINES` до и после, с номерами.
 * Место ищем по тексту замены, а не по позиции: после нескольких правок в одном
 * файле позиции сдвинулись, а вставленный текст — ровно тот, что просили.
 */
export async function editWindows(
  workspace: WorkspaceService,
  edits: Array<{ path: string; newText: string }>,
): Promise<string> {
  const windows: string[] = [];
  const seen = new Set<string>();
  for (const edit of edits) {
    const replacements = edit.newText.split('\n').filter((line) => line.trim().length > 0);
    const needle = replacements[0]?.trim();
    if (!needle) continue;
    // Чтение может быть нечем: в узких тестах у рабочей области нет `readFile`.
    // Окно — украшение к ответу, без него правка остаётся правкой.
    let content: Awaited<ReturnType<WorkspaceService['readFile']>> | null = null;
    try {
      content = await workspace.readFile(edit.path);
    } catch {
      continue;
    }
    if (!content) continue;
    const fileLines = content.text.split('\n');
    const at = fileLines.findIndex((line) => line.trim() === needle);
    if (at < 0) continue;
    const from = Math.max(0, at - EDIT_CONTEXT_LINES);
    const to = Math.min(fileLines.length, at + replacements.length + EDIT_CONTEXT_LINES);
    const key = `${edit.path}:${from}:${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const body = fileLines
      .slice(from, to)
      .map((line, index) => `${from + index + 1} | ${line}`)
      .join('\n');
    windows.push(`${path.basename(edit.path)} (строки ${from + 1}–${to}):\n${body}`);
  }
  return windows.length > 0 ? `\n\nОкно вокруг правки:\n${windows.join('\n\n')}` : '';
}

/** Тексты замен из разобранных правок: по ним ищем место в файле после записи. */
export function editNeedles(parsed: ParsedEdits): Array<{ path: string; newText: string }> {
  return [
    ...parsed.anchors.flatMap((file) => file.patches.map((hunk) => ({ path: file.path, newText: hunk.newText }))),
    ...parsed.positions.flatMap((file) => file.edits.map((edit) => ({ path: file.path, newText: edit.newText }))),
  ].filter((item) => item.newText.trim().length > 0);
}
