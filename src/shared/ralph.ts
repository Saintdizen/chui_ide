/**
 * Цикл раундов (`ralph`): один и тот же вопрос задаётся свежему агенту несколько
 * раз подряд, и каждый следующий раунд знает только сжатый итог прежних.
 *
 * Зачем не один длинный прогон: у длинного прогона контекст растёт и он начинает
 * защищать свои прежние выводы. Свежий агент с чистым контекстом и короткой
 * сводкой находит то, что первый уже не видит, — но только если ему не дают
 * весь прошлый разговор: в нём ровно те же ошибки.
 *
 * Три решения, которые дорого переделывать:
 *
 *   1. Раунды видят СЖАТЫЙ отчёт, а не полный. Полный отчёт — это второй контекст
 *      в чистом контексте; тогда следующий раунд опять считает, что всё уже
 *      решено. Поэтому в раунд едет обрезка (`RALPH_ROUND_CHARS`), а в сводке для
 *      человека остаются отчёты целиком.
 *   2. Раунд сам говорит, что готово (`RALPH_DONE_MARKER`). Без этого цикл всегда
 *      упирается в предел и делает лишний проход, который ничего не находит.
 *   3. Предел ставит человек (`rounds`), и он же обрывает цикл целиком: прерванный
 *      прогон не должен досказывать остаток раундов, они стоят денег.
 *
 * Раунды только смотрят: подзадача читает проект теми же инструментами чтения и
 * ничего не меняет. Правки по итогу делает основной агент.
 *
 * Модуль чистый: разбор аргументов и текст, поэтому проверяется без окна, без
 * модели и без провайдера.
 */

/** Сколько раундов принимаем за один вызов: это «доработать», а не «крутить сутки». */
export const RALPH_MAX_ROUNDS = 5;

/** Умолчание, когда человек предел не назвал: три раунда — типичный «нашёл, проверил, добил». */
export const RALPH_DEFAULT_ROUNDS = 3;

/** Слово, которым раунд говорит «делать больше нечего». */
export const RALPH_DONE_MARKER = 'ГОТОВО';

/** Сколько символов отчёта раунда видит следующий раунд. */
export const RALPH_ROUND_CHARS = 700;

/** Сколько всего сводки едет в раунд: три обрезки по 700 — уже предел пользы. */
export const RALPH_DIGEST_CHARS = 2_000;

/** Один раунд в том виде, в каком его собирает сервис. */
export interface RalphRound {
  /** Номер с единицы — им же подписан отчёт. */
  index: number;
  /** Что раунд ответил. */
  report: string;
}

/** Запрос цикла: задание, предел раундов и подпись для трассы. */
export interface RalphRequest {
  description: string;
  goal: string;
  rounds: number;
  /** Что не так с аргументами. Пусто — можно запускать. */
  error?: string;
}

/** Из-за чего цикл закончился. */
export type RalphStop = 'done' | 'limit' | 'failed' | 'interrupted';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Сколько раундов просили: мусор в поле — умолчание, а не отказ. */
function roundCount(raw: unknown): number {
  const number = typeof raw === 'number' ? raw : Number.parseInt(text(raw), 10);
  if (!Number.isFinite(number)) return RALPH_DEFAULT_ROUNDS;
  return Math.min(RALPH_MAX_ROUNDS, Math.max(1, Math.round(number)));
}

/**
 * Разобрать аргументы вызова.
 *
 * Задание берём из `goal`, а если его нет — из `prompt`: модель, помнящая
 * `task`, всё равно сработает. Предел раундов молча подрезаем, но не меняем
 * смысл: за пределом `RALPH_MAX_ROUNDS` цикл стоил бы дороже, чем человек готов
 * ждать, и об этом сказано в отчёте.
 */
export function parseRalphRequest(args: Record<string, unknown>): RalphRequest {
  const goal = text(args.goal) || text(args.prompt);
  const description = text(args.description) || 'раунды';
  const rounds = roundCount(args.rounds);
  if (!goal) {
    return {
      description,
      goal: '',
      rounds,
      error: 'Нужен goal — что именно довести до готовности. Опиши задачу одной-двумя фразами.',
    };
  }
  return { description, goal, rounds };
}

/**
 * Сказал ли раунд, что готово.
 *
 * Смотрим первую непустую строку: маркер в начале переживает обрезку, а в конце
 * отчёта он может не доехать до следующего раунда.
 */
export function isRalphDone(report: string): boolean {
  const first = (report ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  if (!first) return false;
  // Маркер могут выделить: `**ГОТОВО**`, «готово», `1. ГОТОВО`. Отметки и номера
  // в начале не должны прятать слово — иначе цикл считает раунд неготовым.
  const head = first.replace(/^[^\p{L}]+/u, '').toUpperCase();
  return head.startsWith(RALPH_DONE_MARKER);
}

/** Обрезка отчёта для следующего раунда: по целой строке, чтобы список не рвался посередине. */
export function clipRoundReport(report: string): string {
  const trimmed = (report ?? '').trim();
  if (trimmed.length <= RALPH_ROUND_CHARS) return trimmed;
  const cut = trimmed.slice(0, RALPH_ROUND_CHARS);
  const line = cut.lastIndexOf('\n');
  const body = (line > RALPH_ROUND_CHARS / 2 ? cut.slice(0, line) : cut).trimEnd();
  return `${body}\n… (отчёт обрезан: следующий раунд видит сжатый итог)`;
}

/** Сводка прежних раундов для следующего: обрезки по раунду, всего — не больше `RALPH_DIGEST_CHARS`. */
export function ralphDigest(rounds: readonly RalphRound[]): string {
  const parts = rounds.map((round) => `Раунд ${round.index}:\n${clipRoundReport(round.report)}`);
  const joined = parts.join('\n\n');
  return joined.length <= RALPH_DIGEST_CHARS ? joined : `${joined.slice(0, RALPH_DIGEST_CHARS).trimEnd()}\n…`;
}

/**
 * Запрос раунда: одно задание на весь цикл, сжатый итог прежних и просьба об
 * отчёте. Раунд не видит прошлый разговор — только эту сводку.
 */
export function ralphRoundPrompt(request: RalphRequest, round: number, previous: readonly RalphRound[]): string {
  const digest = previous.length === 0 ? 'Прежних отчётов нет: это первый раунд.' : ralphDigest(previous);
  return [
    request.goal,
    '',
    '---',
    `Ты — раунд ${round} из ${request.rounds} одного цикла. Прошлый разговор тебе не показан целиком; ниже — сжатый итог прежних раундов. Не верь ему на слово: где можно, проверь по файлам.`,
    '',
    digest,
    '',
    'Ты только смотришь: правок не делай, изменения оставь основному агенту.',
    'Отчёт — не длиннее 12 строк:',
    '1) что проверил и чем (файл:строка, команда);',
    '2) что не сходится или осталось не сделано;',
    '3) следующий шаг одной строкой.',
    `Если доводить больше нечего — начни ответ словом ${RALPH_DONE_MARKER} и объясни, почему готово.`,
  ].join('\n');
}

const STOP_TEXT: Record<RalphStop, string> = {
  done: 'раунд сказал, что готово',
  limit: 'предел раундов',
  failed: 'раунд не справился',
  interrupted: 'остановлено человеком',
};

/**
 * Итог цикла для основного агента: отчёты раундов целиком (сводка обрезана, а
 * человек и агент должны видеть, чем именно всё кончилось) и почему встали.
 */
export function formatRalphReport(rounds: readonly RalphRound[], stop: RalphStop, limit: number): string {
  const head = `раундов: ${rounds.length} из ${limit} — ${STOP_TEXT[stop]}`;
  if (rounds.length === 0) {
    return `${head}. Отчётов нет: цикл не начался или прерван до первого шага.`;
  }
  const body = rounds.map((round) => `— Раунд ${round.index}:\n${round.report.trim()}`).join('\n\n');
  const tail =
    stop === 'done'
      ? 'Задание закрыто по слову раунда; если не согласен — проверь сам, раунды только смотрят.'
      : 'Правки по этому отчёту делаешь ты: раунды только смотрят проект.';
  return `${head}\n\n${body}\n\n${tail}`;
}

/** Чем раунд ответил: успел ли и что сказал. */
export interface RalphRoundResult {
  ok: boolean;
  report: string;
}

/** Итог цикла: отчёты по порядку и почему встали. */
export interface RalphRunResult {
  rounds: RalphRound[];
  stop: RalphStop;
}

/**
 * Сам цикл: раунды по очереди, каждый — отдельный прогон.
 *
 * Вынесен из сервиса, чтобы предел раундов и обрыв проверялись без модели:
 * сервис даёт `run` (разговор с агентом) и `aborted` (человек нажал стоп).
 *
 * Порядок проверок важен: обрыв смотрим и до раунда, и после него — человек мог
 * нажать стоп, пока раунд думал, и тогда остаток цикла запускать нельзя.
 */
export async function runRalphRounds(params: {
  request: RalphRequest;
  run: (prompt: string, round: number) => Promise<RalphRoundResult>;
  aborted: () => boolean;
}): Promise<RalphRunResult> {
  const { request, run, aborted } = params;
  const rounds: RalphRound[] = [];
  let stop: RalphStop = 'limit';
  for (let round = 1; round <= request.rounds; round += 1) {
    if (aborted()) {
      stop = 'interrupted';
      break;
    }
    const result = await run(ralphRoundPrompt(request, round, rounds), round);
    rounds.push({ index: round, report: result.report.trim() });
    if (aborted()) {
      stop = 'interrupted';
      break;
    }
    if (!result.ok) {
      stop = 'failed';
      break;
    }
    if (isRalphDone(result.report)) {
      stop = 'done';
      break;
    }
  }
  return { rounds, stop };
}
