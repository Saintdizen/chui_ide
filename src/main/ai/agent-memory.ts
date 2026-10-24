/**
 * Память проекта и проход по прошлым беседам: `mind` (remember/forget/notes) и
 * `history` (search/trace). Обе пары читают то, что уже записано, — кроме
 * `remember`/`forget`, которые пишут в память, а не в файлы проекта.
 */

import { missingForAction, optionalString, requireString, stringList } from './tool-args';
import type { ToolContext, ToolOutcome } from './tool-context';
import type { MemoryScope } from '../../shared/memory';
import { unknownAction } from './agent-present';

import { formatAllNotes } from '../../shared/memory';

/* ── память проекта ─────────────────────────────────────────────────────── */

/** Область памяти из аргументов: по умолчанию — память проекта. */
function readScope(args: Record<string, unknown>): MemoryScope {
  return args.scope === 'global' ? 'global' : 'workspace';
}

/**
 * Записать заметку в память. Память переживает беседу и её сжатие — сюда уходит
 * то, о чём договорились насовсем: предпочтения, решения, «как запускать». Личные
 * предпочтения (язык ответов и прочее), годные в любом проекте, идут в глобальную
 * область (`scope: "global"`). Не дублируем точные повторы и честно отказываем,
 * когда заметок стало слишком много: терять новую из-за переполнения молча нельзя.
 */
export async function remember(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.memory) return { ok: false, summary: 'Память недоступна' };

  const text = requireString(args, 'text');
  const scope = readScope(args);
  const result = await ctx.memory.remember(text, scope);

  if (!result.ok) {
    if (result.reason === 'full') {
      return {
        ok: false,
        summary: 'Память заполнена',
        detail:
          'Заметок стало слишком много. Посмотри их все (`mind` action: "notes"), убери устаревшие через `mind` ' +
          '(action: "forget"), а затем запиши нужную снова — иначе новая заметка потеряется среди старых.',
      };
    }
    return {
      ok: false,
      summary: 'Пустая заметка',
      detail: 'Передай непустой текст в аргументе `text`.',
    };
  }

  const where = scope === 'global' ? 'в глобальной памяти' : 'в памяти проекта';
  return {
    ok: true,
    summary: result.added ? 'заметка записана' : 'такая заметка уже есть',
    detail: `Заметок ${where} теперь: ${result.notes.length}.`,
  };
}

/** Убрать заметки (в области `scope`), в которых встречается подстрока. */
export async function forget(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.memory) return { ok: false, summary: 'Память недоступна' };

  const query = requireString(args, 'query');
  const scope = readScope(args);
  const result = await ctx.memory.forget(query, scope);
  if (result.removed === 0) {
    return {
      ok: true,
      summary: 'подходящих заметок нет',
      detail: `В этой области нет заметок с «${query}». Посмотри список, чтобы уточнить формулировку.`,
    };
  }

  return {
    ok: true,
    summary: `убрано заметок: ${result.removed}`,
    detail: `Осталось заметок: ${result.notes.length}.`,
  };
}

/**
 * Вся память области: в промпт едет только хвост (`MEMORY_PROMPT_CHARS`), и при
 * переполнении агент видит 12 заметок из 40. Без этого действия `forget` бьёт
 * наугад, а отказ `remember` («память заполнена») не показывает, что уже занято.
 */
export async function memoryNotes(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.memory) return { ok: false, summary: 'Память недоступна' };
  const scope = readScope(args);
  const notes = await ctx.memory.notes(scope);
  return {
    ok: true,
    summary: notes.length > 0 ? `заметок: ${notes.length}` : 'память пуста',
    detail: formatAllNotes(notes, scope),
  };
}

/**
 * Память одним инструментом: `remember`, `forget` и `notes` — три глагола об
 * одном хранилище, а стоили трёх схем в каждом запросе. Поля у них разные,
 * поэтому схема общая, а недостающее называется до обработчика — как у `edit`.
 */
export async function mindAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = requireString(args, 'action').trim();
  switch (action) {
    case 'remember':
      return missingForAction(args, ['text'], 'mind') ?? (await remember(ctx, args));
    case 'forget':
      return missingForAction(args, ['query'], 'mind') ?? (await forget(ctx, args));
    case 'notes':
      return await memoryNotes(ctx, args);
    case 'ask':
      return await ask(ctx, args);
    // План и цель — состояние беседы, а не файлы: на диске ничего не меняется,
    // запись делает renderer по самому вызову.
    case 'steps':
      return { ok: true, summary: 'план обновлён' };
    case 'goal':
      return { ok: true, summary: 'цель обновлена' };
    // Утверждение плана перехватывает `service.ts` до вызова обработчика: там
    // решается смена режима. Здесь — только если перехвата не было.
    case 'exit_plan':
      return {
        ok: false,
        summary: 'Утверждать нечего: режим плана не включён',
      };
    default:
      return unknownAction(action, 'mind: remember, forget, notes, ask, steps, goal, exit_plan.');
  }
}

/** Длина вопроса и число вариантов: больше человек и не осилит. */
const MAX_ASK_OPTIONS = 5;
const MAX_QUESTION_CHARS = 2000;

export async function ask(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.ask) return { ok: false, summary: 'Вопрос недоступен: окно чата не подключено' };

  const question = (optionalString(args, 'question') ?? '').trim();
  if (!question) {
    return {
      ok: false,
      summary: 'Не задан вопрос',
      detail: 'Инструменту нужен непустой аргумент question.',
    };
  }

  const options = stringList(args.options).slice(0, MAX_ASK_OPTIONS);
  const answer = (
    await ctx.ask(question.slice(0, MAX_QUESTION_CHARS), options.length > 0 ? options : undefined)
  ).trim();

  if (!answer) {
    return {
      ok: false,
      summary: 'Ответа нет',
      detail:
        'Человек не ответил: вопрос отклонили или прервали прогон. Не повторяй этот же вопрос — ' +
        'продолжай доступными средствами или заверши с тем, что уже есть.',
    };
  }
  return { ok: true, summary: answer, detail: answer };
}
