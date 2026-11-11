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
  // Отказ (ревью, кнопка «отклонить») — это не успех: правок нет, а `failed`
  // пуст, и прежнее условие возвращало `ok: true`. Модель считала, что записала.
  const rejected = decision.rejected === true;
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
    // «Применено» — хотя бы один файл, без провалов и без отказа. Раньше условие
    // смотрело только на `failed`: пустой `applied` с пустым `failed` проходил
    // как успех — модель получала «готово» там, где не записано ничего.
    ok: !rejected && failed.length === 0 && applied.length > 0,
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
  // Верхний адрес — тоже через `firstPath`: `path: ["a.ts"]` адресует тот же файл.
  const top = firstPath(args.path);
  // Массив правок может называться и `patches`/`hunks` (`apply_patch` кладёт их
  // под `patches`, а потом — файлы в `patches[]`): тогда у файла без `path`
  // верхний путь тоже работает.
  const raw = args.edits ?? args.patches ?? args.hunks;

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
      const editsFor = item.edits ?? item.patches ?? item.hunks;
      const file: Record<string, unknown> = { ...(item as Record<string, unknown>) };
      if (!Array.isArray(item.edits) && (hasInnerEdits(item) || hunk))
        file.edits = Array.isArray(editsFor) ? editsFor : [hunk];
      const named = !firstPath(file.path) && top ? { ...file, path: top } : file;
      // Внутренний список зовётся `edits`, какое бы имя ни выбрала модель.
      const inner = named.edits ?? named.patches ?? named.hunks;
      return Array.isArray(inner) && inner !== named.edits ? { ...named, edits: inner } : named;
    });
  }

  // Плоская форма: элементы — сами замены. Но файл может быть назван вокруг
  // массива: `{path, edits: [{startLine, newText}]}` без единого `path` в самих
  // заменах — та же ошибка обёртки (замер 30.10: 3 отказа `edit` из 16).
  const groups = new Map<string, unknown[]>();
  for (const item of list) {
    // Замена без своего пути: адрес берём с верхнего уровня.
    const itemPath = isRecord(item) ? (firstPath(item.path) ?? top) : top;
    // Путь не найти — не угадываем: пусть отказ назовёт форму (это данные, а не шум).
    // Поля проставляем и здесь: без них отказ говорит «patches[0]: не задан path»,
    // а по чему — не говорит вовсе (замер 02.11: из 11 таких отказов 3 пришли как
    // «применено файлов: 0, с ошибками: 1» — сводка заместила настоящую причину).
    if (!itemPath) return describePathless(list, args, 'patches');
    const bucket = groups.get(itemPath) ?? [];
    // Замена во плоской форме (`{path, oldText, newText}` среди замен) — тоже по адресу:
    // иначе до разбора дошёл бы `path` как чужое поле замены, и вызов бы отвалился.
    bucket.push(isRecord(item) ? (flatHunk(item) ?? item) : item);
    groups.set(itemPath, bucket);
  }
  return [...groups.entries()].map(([filePath, edits]) => ({
    path: filePath,
    edits,
  }));
}

/** Элемент правки — файл с вложенными заменами, а не сама замена. */
export function hasInnerEdits(item: unknown): boolean {
  return isRecord(item) && (Array.isArray(item.edits) || Array.isArray(item.patches) || Array.isArray(item.hunks));
}

/**
 * Замена, лежащая в самом элементе файла: `{path, oldText, newText}`. Схема `edit`
 * объявляет `edits` массивом, и модель кладёт в него ровно такую запись — путь и
 * замена рядом. Отказ здесь был вторым по частоте («у элемента не нашлось якоря»),
 * хотя в действительности было ясно, что менять и чем.
 */
export function flatHunk(item: Record<string, unknown>): Record<string, unknown> | null {
  // `contents` — та же запись целиком, только названная как у `create`. Без этой
  // строки `{path, contents}` проходил мимо `flatHunk`, доезжал до разбора замен
  // и падал на «edits[0].edits[0].newText: нужна строка» — хотя данные все на
  // месте (проверено 29.10).
  const whole = typeof item.contents === 'string' ? item.contents : undefined;
  // Без старого текста, без `newText` и без `contents` — не правка, а мусор: отказать
  // форме честнее, чем применять пустоту.
  if (typeof item.oldText !== 'string' && typeof item.newText !== 'string' && whole === undefined) return null;
  const hunk: Record<string, unknown> = {};
  if (typeof item.newText === 'string') hunk.newText = item.newText;
  if (whole !== undefined) hunk.contents = whole;
  if (typeof item.oldText === 'string') hunk.oldText = item.oldText;
  for (const key of ['startLine', 'startColumn', 'endLine', 'endColumn'] as const) {
    if (typeof item[key] === 'number') hunk[key] = item[key];
  }
  return hunk;
}

/**
 * Отказ на список замен без единого пути — с картой полей, которая довела до него.
 *
 * Зачем. Такой вызов разбор принять не может (адреса нет нигде), но и молчать о
 * том, где его искали, нельзя: голое «patches[0]: не задан path» не говорит, куда
 * модель положила `path` — а он может лежать рядом, в `file`, `filePath`, `target`
 * или выше — в `edits[0].path`. Замер 02.11: каждый такой отказ стоил шага на
 * переписывание, а треть дошла до отчёта обезличенной сводкой.
 *
 * Перечёркнутые имена — те, что в вызове были, но не годятся как путь; порядок —
 * как в исходной записи, чтобы перепись считала формы по одному шаблону.
 */
export function describePathless(
  list: unknown[],
  args: Record<string, unknown>,
  field: string,
): Record<string, unknown>[] {
  const first = isRecord(list[0]) ? list[0] : undefined;
  const seen = Object.keys(first ?? {}).filter((key) => first?.[key] !== undefined);
  const topKeys = Object.keys(args).filter((key) => args[key] !== undefined);
  // Имена, похожие на путь, но не путь: значение пустое или не строка. Их важно
  // назвать отдельно — иначе причина выглядит как «полей нет».
  const rejected = [...new Set([...seen, ...topKeys])]
    .filter((key) => PATH_LIKE.test(key))
    .map((key) => `${key}=${emptyish(first?.[key] ?? args[key])}`);
  return list.map((item, index) => {
    const record = isRecord(item) ? item : {};
    return {
      ...record,
      [field]: index
        ? item
        : {
            ...(isRecord(item) ? item : {}),
            // Поля разбора: по ним отказ называет не только место, но и что там было.
            path: undefined,
            seenFields: seen.join(','),
            topFields: topKeys.join(','),
            rejectedPathFields: rejected.join(','),
            hint:
              'path не задан ни у замены, ни на верхнем уровне; ' +
              'положите его в каждый элемент или один раз сверху: {path, edits:[...]} или {edits:[{path, ...}]}',
          },
    };
  });
}

/** Имя поля, которое модель зовёт вместо `path`. */
const PATH_LIKE = /^(?:.*path|file|filename|filePath|target|name|url)$/i;

/** Значение поля — пустое или не строка: именно поэтому оно не стало путём. */
function emptyish(value: unknown): string {
  if (value === undefined) return 'нет';
  if (typeof value === 'string') return value.trim() ? `строка (${value.length} симв.)` : 'пустая строка';
  if (value === null) return 'null';
  // Список с единственной строкой — тоже путь; длиннее — уже не один адрес.
  if (Array.isArray(value)) return `список из ${value.length}: ${value.map(emptyish).join(', ')}`;
  return typeof value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Путь, присланный одним значением или списком (`path: ["a.ts"]`).
 *
 * Зачем. Списочная запись — та же адресация, просто массивом. Разбор принимал
 * её за отсутствие пути и отказывал, хотя исполнять было что. Список длиннее
 * одного не склеиваем: у замены один адрес, и выбрать из двух — догадка.
 */
function firstPath(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim().length > 0 ? value : undefined;
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const only = value[0];
  return typeof only === 'string' && only.trim().length > 0 ? only : undefined;
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
    // Текст замены — `newText`, но `flatHunk` кладёт запись целиком в `contents`
    // (замена без якоря и без позиций — это и есть файл). Без второго ключа
    // вызов отваливался «не задан path» там, где файл назван и текст есть (30.10).
    const text = typeof edit.newText === 'string' ? edit.newText : edit.contents;
    if (positional || typeof edit.oldText === 'string' || typeof text !== 'string') return null;
    parts.push(text);
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
  // Причины склеиваем так же, как сам список: без них `describeUnwritten`
  // остаётся без «почему», и следующий круг агент делает догадками.
  const reasons = decisions.flatMap((decision) => Object.entries(decision.unwrittenReasons ?? {}));
  return {
    rejected: decisions.some((decision) => decision.rejected),
    result: {
      reports: decisions.flatMap((decision) => decision.result?.reports ?? []),
      failed: decisions.flatMap((decision) => decision.result?.failed ?? []),
    },
    unwritten: decisions.flatMap((decision) => decision.unwritten ?? []),
    ...(reasons.length > 0 ? { unwrittenReasons: Object.fromEntries(reasons) } : {}),
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
  const missing = missingForAction(args, FILE_ARGS[action] ?? RETIRED_FILE_ARGS[action] ?? []);
  if (missing) return missing;
  // Смысл каждого действия — в его полях, а не в шапке: шапку модель читает один
  // раз, а поле — ровно перед тем, как его заполнить. `contents` у `create` и
  // `replacement` у `replace` путали чаще всего («не задан аргумент contents»
  // приходил на `replace` — модель несла новое содержимое из привычки).
  // `create` живёт в приёмнике ради старых бесед, но схемой не объявлен: новая
  // запись идёт через `edit` (новый файл — запись целиком в `edits`). Молча
  // исполнять необъявленное действие — значит оставлять два способа записи;
  // поэтому отвечаем вслух и называем один (замер 30.10: 12 вызовов вне схемы).
  if (action === 'create')
    return {
      ok: false,
      summary: 'действие create снято — новый файл пишется через edit',
      detail:
        'Инструмент file больше не создаёт файлы: та же запись есть у edit — ' +
        '`edit {edits: [{path, edits: [{newText: "…"}]}]}` без `oldText` создаёт файл целиком. ' +
        'file оставлен для move и delete.',
    };
  if (action === 'move') return await moveFile(ctx.workspace, args);
  if (action === 'delete') return await deleteFile(ctx.workspace, args);
  if (action === 'copy') return await copyPath(ctx.workspace, args);
  if (action === 'mkdir') return await makeDirectory(ctx.workspace, args);
  if (action === 'format') return await formatFile(ctx, args);
  if (action === 'organizeImports') return await organizeImports(ctx, args);
  // `replace` тоже снят: его заменял `search` + `edit`. Не документированное действие
  // в приёмнике — второй способ делать то же самое; остаются только имена файлов.
  if (action === 'replace')
    return {
      ok: false,
      summary: 'действие replace снято — замена текста идёт через search + edit',
      detail:
        'Инструмент file больше не ищет и не меняет текст: найдя места через `search`, ' +
        'правь их `edit {edits: [{path, edits: [{oldText, newText}]}]}`. Файл целиком — ' +
        'тот же `edit` без `oldText`. file оставлен для move и delete.',
    };
  return unknownAction(action, 'file: move, copy, mkdir, delete, format, organizeImports.');
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

/** Копия файла или папки. Целевой путь не должен существовать — как и у переноса. */
export async function copyPath(workspace: WorkspaceService, args: Record<string, unknown>): Promise<ToolOutcome> {
  const from = requireString(args, 'from');
  const to = requireString(args, 'to');
  const copied = await workspace.copy(from, to);
  const root = workspace.rootPath();
  return {
    ok: true,
    summary: `${relative(from, root)} → ${relative(copied, root)}`,
    detail: `Скопировано: ${from} → ${copied}.`,
    changes: [{ path: copied, kind: 'created' }],
  };
}

/** Папка: у `create_dir` путь в `path`, создаётся со всеми недостающими родителями. */
export async function makeDirectory(workspace: WorkspaceService, args: Record<string, unknown>): Promise<ToolOutcome> {
  const target = requireString(args, 'path');
  const made = await workspace.createDir(target);
  const root = workspace.rootPath();
  return {
    ok: true,
    summary: relative(made, root),
    detail: `Папка создана: ${made}.`,
    changes: [{ path: made, kind: 'created' }],
  };
}

/**
 * Форматирование файла сервером языка — без записи на диск.
 *
 * Отдаём готовый текст, а не записываем сами: модель видит разницу и решает,
 * нужно ли оно вообще. Запись — уже `edit`, и она проходит обычное ревью.
 */
export async function formatFile(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const target = requireString(args, 'path');
  if (!ctx.formatFile) {
    return { ok: false, summary: 'Языковой сервер не подключён: форматировать нечем' };
  }
  const formatted = await ctx.formatFile(target);
  if (formatted === null) {
    return { ok: false, summary: 'Сервер не умеет форматировать этот файл' };
  }
  if (formatted === '') return { ok: true, summary: 'Файл уже отформатирован', detail: '' };
  const root = ctx.workspace.rootPath();
  return {
    ok: true,
    summary: `${relative(target, root)}: отформатирован`,
    detail: formatted,
    changes: [{ path: target, kind: 'modified' }],
  };
}

export async function organizeImports(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const target = requireString(args, 'path');
  if (!ctx.organizeImports) {
    return { ok: false, summary: 'Языковой сервер не подключён: сортировать импорты нечем' };
  }
  const organized = await ctx.organizeImports(target);
  if (organized === null) {
    return { ok: false, summary: 'Сервер не умеет сортировать импорты в этом файле' };
  }
  if (organized === '') return { ok: true, summary: 'Импорты уже в порядке', detail: '' };
  const root = ctx.workspace.rootPath();
  return {
    ok: true,
    summary: `${relative(target, root)}: импорты приведены в порядок`,
    detail: organized,
    changes: [{ path: target, kind: 'modified' }],
  };
}

/**
 * Обязательные поля каждого действия `file`. Их называет не только разбор, но и
 * ответ на опечатку в `action`: модель тогда видит, каких аргументов не хватало.
 */
const FILE_ARGS: Record<string, readonly string[]> = {
  move: ['from', 'to'],
  // `copy` не было в таблице: вызов без `from`/`to` проходил проверку и падал
  // исключением из глубины — модель не видела, каких полей не хватило.
  copy: ['from', 'to'],
  delete: ['path'],
  organizeImports: ['path'],
  format: ['path'],
  // Два способа создать файл — папку под него и текст в файл — раньше собирали
  // через терминал: `mkdir` без подтверждения, `cp` тоже. Имена свои.
  mkdir: ['path'],
};

/**
 * Снятые действия — не живые, а подсказка для старых бесед.
 *
 * `create` и `replace` больше не объявлены в схеме `file` (их заменили `edit` и
 * `search`+`edit`), но старые беседы зовут их по имени и получают отказ. Отказ
 * называет поля — поэтому имена остались. В общей таблице они читались как
 * живые: два ключа из семи были снятыми и из кода это не следовало. Теперь
 * отдельная таблица — добавка сюда сразу видна и не тонет в живых действиях.
 */
const RETIRED_FILE_ARGS: Record<string, readonly string[]> = {
  create: ['path', 'contents'],
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
