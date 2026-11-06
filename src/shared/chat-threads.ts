import type { ChatRunTrace } from './api/ai';
import { formatCost, usageCost } from './usage';

/**
 * Нить работы — это беседа, у которой видно, чем она занята.
 *
 * Вкладок чата бывает много, и все они выглядят одинаково: имя да пульсирующая
 * точка у тех, что генерируют. Но у параллельных задач разное состояние — одна
 * идёт, другая ждёт человека, третья упала; и разная цена. Пока этого не видно,
 * человек держит в голове сам, где именно идёт работа.
 *
 * Здесь — только чистый расчёт: состояние и цена по данным беседы. Рисует
 * `ui/chat-tabs.ts`, а данные даёт `ui/chat.ts`.
 */

/** Чем нить занята прямо сейчас. */
export type ThreadState =
  /** Идёт генерация. */
  | 'running'
  /** Прогон кончился, но хода человеку не было: ждёт решения. */
  | 'waiting'
  /** Упала: последний прогон кончился ошибкой. */
  | 'failed'
  /** Задача отложена — её держат вместе с другими. */
  | 'paused'
  /** Свободна: переписка есть, делать нечего. */
  | 'idle'
  /** Пустая: ещё ничего не написано. */
  | 'empty';

/** Что известно о беседе для полосы вкладок. */
export interface ThreadInput {
  id: number;
  /** Идёт ли генерация сейчас. */
  running: boolean;
  /** Начат ли разговор: беседа с одним приветствием — пустая. */
  hasHistory: boolean;
  /** Последний прогон кончился ошибкой. */
  failed?: boolean;
  /** Задача отложена: её держат вместе с другими. */
  paused?: boolean;
  /** Итоги последнего прогона — из них цена. */
  trace?: ChatRunTrace;
  /** Модель беседы: без неё цену не посчитать. */
  model?: string;
}

/** Нить в полосе вкладок: состояние, подпись и цена. */
export interface ThreadInfo {
  id: number;
  state: ThreadState;
  /** Короткая подпись состояния — для подсказки у вкладки. */
  label: string;
  /** Цена последнего прогона, $; `null` — модели нет в тарифах. */
  cost: number | null;
  /** Прочитанный текст цены («0.04») или `null`. */
  costText: string | null;
}

const STATE_LABELS: Record<ThreadState, string> = {
  running: 'идёт',
  waiting: 'ждёт тебя',
  failed: 'упала',
  paused: 'на паузе',
  idle: 'готова',
  empty: 'пусто',
};

/**
 * Состояние нити. Порядок проверок — это приоритет: идти важнее, чем ждать,
 * а ждать важнее, чем «просто открыта». Упавший прогон перебивает паузу: без
 * решения человека он так и стоит.
 */
export function threadState(input: ThreadInput): ThreadState {
  if (input.running) return 'running';
  if (input.failed) return 'failed';
  if (input.paused) return 'paused';
  if (input.hasHistory) return 'idle';
  return 'empty';
}

/** Описание нити для полосы вкладок. */
export function describeThread(input: ThreadInput): ThreadInfo {
  const state = threadState(input);
  const cost = input.trace && input.model ? usageCost(input.trace.usage, input.model) : null;
  return {
    id: input.id,
    state,
    label: STATE_LABELS[state],
    cost,
    costText: cost === null ? null : formatCost(cost),
  };
}

/**
 * Сколько нитей чем занято — для сводки над полосой.
 *
 * Идущие считаются отдельно от ждущих: «3 нити» ничего не говорят о том, куда
 * смотреть. Пустое не считаем вовсе — оно не работа.
 */
export interface ThreadSummary {
  running: number;
  waiting: number;
  failed: number;
  paused: number;
  /** Сумма цен, $; `null` — ни у одной нити цена не известна. */
  cost: number | null;
  /** Короткая строка: «2 идут · 1 ждёт тебя» либо пусто. */
  text: string;
}

export function summarizeThreads(threads: readonly ThreadInfo[]): ThreadSummary {
  const count = (state: ThreadState) => threads.filter((item) => item.state === state).length;
  const running = count('running');
  const waiting = count('waiting');
  const failed = count('failed');
  const paused = count('paused');
  const costs = threads.map((item) => item.cost).filter((value): value is number => value !== null);
  const cost = costs.length > 0 ? costs.reduce((sum, value) => sum + value, 0) : null;

  const parts: string[] = [];
  if (running > 0) parts.push(`${running} ${plural(running, 'идёт', 'идут', 'идут')}`);
  if (waiting > 0) parts.push(`${waiting} ${plural(waiting, 'ждёт', 'ждут', 'ждут')} тебя`);
  if (failed > 0) parts.push(`${failed} ${plural(failed, 'упала', 'упали', 'упали')}`);
  if (paused > 0) parts.push(`${paused} на паузе`);
  return { running, waiting, failed, paused, cost, text: parts.join(' · ') };
}

/**
 * Русское число согласуется со словом: 1 идёт, 2 идут, 5 идут. Слова передаются
 * готовыми — склонять их по общим правилам здесь нечего.
 */
function plural(value: number, one: string, few: string, many: string): string {
  const mod10 = value % 10;
  const mod100 = value % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
