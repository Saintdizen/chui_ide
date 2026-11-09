import { todoMarks } from '../../shared/todo-comments';
import { optionalInteger, optionalString } from './tool-args';
import { relativePath } from './agent-terminal';
import type { ToolContext, ToolOutcome } from './tool-context';

/**
 * `todo`: пометки TODO/FIXME/HACK/XXX по проекту.
 *
 * Зачем: у редактора панель пометок есть, а у модели — нет. Она их находит
 * обычным `search`, но поиск по `TODO` даёт сырые строки без разбора: не видно
 * ни автора, ни срока, ни того, что пометка стоит в комментарии, а не в
 * строковом литерале.
 *
 * Здесь тот же разбор, что у подсветки (`todoMarks`), плюс два уточнения:
 * соседние пометки в одной строке считаются одной, а `path` сужает обход до
 * файла или папки.
 */

/** Сколько пометок отдаём по умолчанию и сколько всего. */
const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 300;
/** Сколько символов строки держим в ответе: длинный литерал — не повод. */
const LINE_WIDTH = 160;

export interface TodoHit {
  readonly path: string;
  readonly line: number;
  readonly kind: string;
  /** Строка целиком, обрезанная: по ней видно, о чём пометка. */
  readonly text: string;
}

/**
 * Разобрать один файл: строки с пометками и слово пометки.
 *
 * Пометки ищутся по всей строке, а не только в комментарии: TODO в строковом
 * литерале (текст ошибки, шаблон) — тоже пометка, и модель должна её видеть.
 * Границы слова уже в `todoMarks`: `TODOS` или `MethodTODO` не считаются.
 */
export function scanTodoText(path: string, text: string, limit: number): TodoHit[] {
  const hits: TodoHit[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length && hits.length < limit; index += 1) {
    const line = lines[index] ?? '';
    const marks = todoMarks(line);
    if (marks.length === 0) continue;
    // Слово первой пометки — вид для сводки; их может быть несколько в строке.
    const kind = line.slice(marks[0]!.start, marks[0]!.end).toUpperCase();
    hits.push({ path, line: index + 1, kind, text: trimLine(line) });
  }
  return hits;
}

/** Строка для ответа: без хвостовых пробелов и не длиннее `LINE_WIDTH`. */
function trimLine(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > LINE_WIDTH ? `${trimmed.slice(0, LINE_WIDTH - 1)}…` : trimmed;
}

/** Файлы проекта для обхода: `path` сужает до папки или одного файла. */
async function filesToScan(ctx: ToolContext, scope: string | undefined): Promise<string[]> {
  const all = await ctx.workspace.findFiles('**/*', 5000);
  if (!scope) return all;
  const prefix = scope.replace(/^\.\//, '');
  const isFile = /\.\w+$/.test(prefix);
  return all.filter((file) => (isFile ? file === prefix : file === prefix || file.startsWith(`${prefix}/`)));
}

export async function todoAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const limit = Math.min(Math.max(optionalInteger(args, 'limit') ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const scope = optionalString(args, 'path');
  const kindFilter = (optionalString(args, 'kind') ?? '').trim().toUpperCase();
  const root = ctx.workspace.rootPath();

  const files = await filesToScan(ctx, scope);
  const hits: TodoHit[] = [];
  let scanned = 0;
  let cut = false;
  for (const file of files) {
    if (hits.length >= limit) {
      cut = true;
      break;
    }
    // Картинки и архивы зря не читаем: байты в utf8 — не строки.
    if (/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|so|dll|exe|bin|mp[34])$/i.test(file)) continue;
    let text: string;
    try {
      const absolute = !root || file.startsWith('/') ? file : `${root}/${file}`;
      text = (await ctx.workspace.readFile(absolute)).text;
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue;
    scanned += 1;
    for (const hit of scanTodoText(file, text, limit - hits.length)) {
      if (kindFilter && hit.kind !== kindFilter) continue;
      hits.push(hit);
    }
  }

  if (hits.length === 0) {
    const what = scope ? `в ${scope}` : 'в проекте';
    return {
      ok: true,
      summary: `todo: пометок нет ${what}`,
      detail:
        `Пометок TODO/FIXME/HACK/XXX ${what} не нашлось (просмотрено файлов: ${scanned}). ` +
        'Если ждёшь находку — проверь path: он сужает обход.',
    };
  }

  const kinds = new Map<string, number>();
  for (const hit of hits) kinds.set(hit.kind, (kinds.get(hit.kind) ?? 0) + 1);
  const summary = [...kinds.entries()].map(([kind, count]) => `${kind} ${count}`).join(', ');
  const rows = hits.map((hit) => `${relativePath(hit.path, root ?? null)}:${hit.line} [${hit.kind}] ${hit.text}`);
  const tail = cut ? `\n… (показаны первые ${hits.length}: увеличь limit или сузь path)` : '';
  return {
    ok: true,
    summary: `todo: ${hits.length} пометок (${summary})`,
    detail: `Пометки по проекту — путь:строка, вид, строка.\n${rows.join('\n')}${tail}`,
  };
}
