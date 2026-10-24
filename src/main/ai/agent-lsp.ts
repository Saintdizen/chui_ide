/**
 * Языковой сервер: ссылки, переход к определению, переименование и вход
 * `lspAction` из таблицы инструментов. Оглавление файла (`fileOutline`) живёт в
 * `agent-code.ts`: оно нужно и без сервера.
 */

import path from 'node:path';
import { formatLocations } from '../../shared/lsp-locations';
import type { SymbolLocation } from '../../shared/lsp-locations';
import { rankSymbols } from '../../shared/code-search';
import type { SearchSymbol } from '../../shared/code-search';
import { unknownAction } from './agent-present';
import { missingForAction, optionalBoolean, optionalInteger, optionalString, requireString } from './tool-args';
import { relative, relativePath } from './agent-terminal';
import { readEditsOutcome } from './agent-edit';
import { fileOutline } from './agent-code';
import type { ToolContext, ToolOutcome } from './tool-context';

/* ── ссылки и переход к определению (языковой сервер) ───────────────────── */

/** Сколько объявлений учитываем при выборе цели: важно ближайшее по имени, а не все. */
const MAX_SYMBOL_CANDIDATES = 20;

/** Путь аргумента, приведённый к абсолютному внутри рабочей папки; null — аргумента нет. */
function resolvePathArg(ctx: ToolContext, value: string | undefined): string | null {
  if (!value) return null;
  const root = ctx.workspace.rootPath();
  if (!root) return null;
  const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
  const rel = path.relative(root, absolute);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return absolute;
}

/** Один и тот же файл: пути могут отличаться разделителем или регистром диска. */
function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

/**
 * Ближайшее объявление символа по имени. Сервер отдаёт список совпадений, а нам
 * нужна одна цель — та, чьи ссылки смотреть или от которой перейти к определению;
 * `rankSymbols` ставит точные совпадения и короткие имена вперёд.
 */
export async function resolveSymbol(
  ctx: ToolContext,
  name: string,
  pathFilter: string | null,
): Promise<SearchSymbol | null> {
  if (!ctx.symbols) return null;
  const found = await ctx.symbols.projectSymbols(name).catch(() => [] as readonly SearchSymbol[]);
  const ranked = rankSymbols(found, name, MAX_SYMBOL_CANDIDATES);
  if (pathFilter) {
    // Сравниваем приведённые пути, а не строки: языковой сервер может написать
    // тот же файл другим разделителем или регистром диска.
    const inFile = ranked.find((symbol) => samePath(symbol.path, pathFilter));
    if (inFile) return inFile;
  }
  return ranked[0] ?? null;
}

/** Текст и язык файла — их требует запрос к серверу по позиции. */
async function documentOf(
  ctx: ToolContext,
  target: string,
): Promise<{ text: string; language: string } | { error: ToolOutcome }> {
  const language = ctx.symbols?.languageFor?.(target);
  if (!language) {
    return {
      error: {
        ok: false,
        summary: `${relative(target, ctx.workspace.rootPath())}: язык не распознан`,
        detail: 'Для этого расширения языкового сервера нет — ссылки и переход недоступны.',
      },
    };
  }
  const content = await ctx.workspace.readFile(target);
  return { text: content.text, language };
}

/**
 * Ссылки на символ: где он ещё встречается. Сперва находим объявление по имени
 * (`workspace/symbol`), затем просим сервер о ссылках в этой позиции. Позиция
 * объявления известна точно, а курсора у агента нет — поэтому и по имени, а не
 * по позиции.
 */
export async function findReferences(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.symbols?.references) {
    return {
      ok: false,
      summary: 'Языковой сервер не подключён: поиск ссылок недоступен',
    };
  }

  const name = requireString(args, 'symbol').trim();
  const root = ctx.workspace.rootPath();
  const target = await resolveSymbol(ctx, name, resolvePathArg(ctx, optionalString(args, 'path')));
  if (!target) {
    return {
      ok: true,
      summary: `объявление «${name}» не найдено`,
      detail:
        'Языковой сервер не нашёл объявления с таким именем. Уточни имя (или напиши его словами, ' +
        'например «read file») либо посмотри search с action code.',
    };
  }

  const doc = await documentOf(ctx, target.path);
  if ('error' in doc) return doc.error;

  const includeDeclaration = optionalBoolean(args, 'includeDeclaration') ?? true;
  const locations = await ctx.symbols.references(
    target.path,
    doc.language,
    doc.text,
    target.line,
    target.column,
    includeDeclaration,
  );
  if (locations === null) {
    return {
      ok: false,
      summary: `${target.name}: сервер этого языка не ищет ссылки`,
      detail:
        'Языковой сервер не умеет `textDocument/references`. Ищи вхождения через search — но ' +
        'текстовый поиск ловит и комментарии с одноимёнными переменными.',
    };
  }

  const subject = `ссылки на ${target.name} (объявлен в ${relative(target.path, root)})`;
  const report = formatLocations(subject, locations, (target) => relativePath(target, root));
  return { ok: true, summary: report.summary, detail: report.detail };
}

/**
 * Переход к определению: по имени (где символ объявлен) или из позиции
 * использования (переход делает сервер). Имя — обычный случай: у агента нет
 * курсора, а позицию он берёт из тех же ссылок.
 */
export async function goToDefinition(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  // Аргументы проверяем ДО сервера: пустой вызов без них — это ошибка вызова, а не
  // «языковой сервер не подключён». Раньше ответ говорил про сервер, и модель шла
  // чинить не то.
  const hasName = (optionalString(args, 'symbol') ?? '').trim().length > 0;
  const hasPosition = args.path !== undefined && args.line !== undefined;
  if (!hasName && !hasPosition) {
    return {
      ok: false,
      summary: 'Нужен symbol или path вместе с line',
      detail: 'Передай имя символа (`symbol`) либо файл и строку с использованием (`path` и `line`).',
    };
  }
  if (!ctx.symbols) {
    return {
      ok: false,
      summary: 'Языковой сервер не подключён: переход к определению недоступен',
    };
  }

  const root = ctx.workspace.rootPath();
  const pathArg = resolvePathArg(ctx, optionalString(args, 'path'));
  const line = optionalInteger(args, 'line');

  // Позиционный переход: файл и строка с использованием известны — решает сервер.
  if (pathArg && line) {
    if (!ctx.symbols.definition) {
      return {
        ok: false,
        summary: 'Языковой сервер не подключён: переход по позиции недоступен',
      };
    }
    const doc = await documentOf(ctx, pathArg);
    if ('error' in doc) return doc.error;

    const column = optionalInteger(args, 'column') ?? 1;
    const locations = await ctx.symbols.definition(pathArg, doc.language, doc.text, line, column);
    if (locations === null) {
      return {
        ok: false,
        summary: 'Сервер этого языка не умеет переход к определению',
        detail: 'Попробуй назвать символ аргументом `symbol` — тогда объявление ищется по имени.',
      };
    }
    const subject = `определение из ${relative(pathArg, root)}:${line}`;
    const report = formatLocations(subject, locations, (target) => relativePath(target, root));
    return { ok: true, summary: report.summary, detail: report.detail };
  }

  // Переход по имени: сервер отдаёт объявления символа прямо по имени.
  const name = optionalString(args, 'symbol');
  if (!name) {
    return {
      ok: false,
      summary: 'Нужен symbol или path вместе с line',
      detail: 'Передай имя символа (`symbol`) либо файл и строку с использованием (`path` и `line`).',
    };
  }

  const found = await ctx.symbols.projectSymbols(name).catch(() => [] as readonly SearchSymbol[]);
  const locations: SymbolLocation[] = rankSymbols(found, name, MAX_SYMBOL_CANDIDATES).map((symbol) => ({
    path: symbol.path,
    line: symbol.line,
    column: symbol.column,
  }));
  const report = formatLocations(`определение ${name}`, locations, (target) => relativePath(target, root));
  return { ok: true, summary: report.summary, detail: report.detail };
}

/**
 * Переименование символа с учётом семантики: сервер находит объявление по имени,
 * возвращает правки во всех местах использования (включая другие файлы) — их
 * применяет документная модель renderer, тем же путём, что правка по позициям, поэтому
 * работает undo и ревью. Это не `replace_in_files`: та бьёт по подстроке и не
 * знает границ символа, а здесь имя меняется только там, где оно — этот символ.
 */
export async function renameSymbol(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.symbols?.rename) {
    return {
      ok: false,
      summary: 'Языковой сервер не подключён: переименование символа недоступно',
    };
  }
  if (!ctx.applyEdits) {
    return {
      ok: false,
      summary: 'Правки сейчас недоступны: окно редактора не подключено',
    };
  }

  const name = requireString(args, 'symbol').trim();
  const newName = requireString(args, 'newName').trim();
  if (name === newName) {
    return { ok: false, summary: 'Новое имя совпадает со старым' };
  }

  const root = ctx.workspace.rootPath();
  const target = await resolveSymbol(ctx, name, resolvePathArg(ctx, optionalString(args, 'path')));
  if (!target) {
    return {
      ok: true,
      summary: `объявление «${name}» не найдено`,
      detail:
        'Языковой сервер не нашёл объявления с таким именем. Уточни имя либо посмотри search (action code). ' +
        'Для массовой замены подстроки есть `file` (action replace), но он не знает семантики.',
    };
  }

  const doc = await documentOf(ctx, target.path);
  if ('error' in doc) return doc.error;

  const edits = await ctx.symbols.rename(target.path, doc.language, doc.text, target.line, target.column, newName);
  if (edits === null) {
    return {
      ok: false,
      summary: `${target.name}: сервер этого языка не умеет переименование`,
      detail:
        'Языковой сервер не поддерживает `textDocument/rename`. Для замены подстроки используй `file` (action replace).',
    };
  }
  if (edits.length === 0) {
    return {
      ok: true,
      summary: `переименовывать нечего: ${target.name}`,
      detail: 'Сервер не вернул правок.',
    };
  }

  const files = edits.map((file) => ({
    ...file,
    path: path.resolve(file.path),
  }));
  const decision = await ctx.applyEdits(files, ctx.autoApprove === true);
  if (decision.rejected) {
    return {
      ok: false,
      summary: `Пользователь отклонил переименование: ${name} → ${newName}`,
      detail: 'Пользователь отклонил правки. Не повторяй вызов — предложи другой ход.',
    };
  }

  const outcome = readEditsOutcome(decision, (file) => relative(file, root));

  return {
    ok: outcome.ok,
    summary: `${name} → ${newName}: файлов ${outcome.applied.length}${outcome.failed.length ? `, с ошибками ${outcome.failed.length}` : ''}${outcome.tail}`,
    detail: outcome.detail,
    // Переименование — тоже правка: если она легла только в буфер, тела правок
    // не забываем; чтение с диска вернёт старое имя, и правку придётся повторить.
    ...(outcome.ok && outcome.tail === '' ? { applied: true } : {}),
  };
}

/**
 * Проверка кода линтером проекта. Путь необязателен: без него проверяем проект
 * целиком. Названную цель прогоняем через `workspace.stat` — это заодно проверка,
 * что путь внутри рабочей папки (та же граница, что у чтения и правок).
 */
export async function lspAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = requireString(args, 'action').trim();
  switch (action) {
    case 'references':
      return missingForAction(args, ['symbol']) ?? (await findReferences(ctx, args));
    case 'definition':
      return await goToDefinition(ctx, args);
    case 'outline':
      return missingForAction(args, ['path']) ?? (await fileOutline(ctx, args));
    case 'rename':
      return missingForAction(args, ['symbol', 'newName']) ?? (await renameSymbol(ctx, args));
    default:
      return unknownAction(action, 'lsp: references, definition, outline, rename.');
  }
}

/** Проверки: пометки редактора и линтер — оба про «что не так с кодом». */
