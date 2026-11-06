/**
 * Что main делает прямо сейчас: прогоны бесед и их инструменты.
 *
 * Отмена — `AbortController` в `ipc/router.ts` — гасит прогон и доходит до
 * `signal`, который видят инструменты. Но «стоп» умеет отменить лишь тот вызов,
 * чей id у него на руках: если окно перезапустили или прогон начал другой вход,
 * отменять нечего — а команда, чтение и запись продолжают жить. И человек не
 * видит, что именно ещё идёт.
 *
 * Здесь — опись: по беседе видно, идёт ли прогон и какие инструменты
 * выполняются. Дешёвая: запись на старте, снятие в `finally`.
 */

import type { RunningSnapshot } from '../../shared/api/ai';

/** Инструмент, который идёт прямо сейчас. */
export interface RunningTool {
  /** Имя, как у модели: `terminal`, `read`, `edit`, … */
  name: string;
  startedAt: number;
  /** Чем его отменить: гаснет вслед за прогоном, но и сам по себе. */
  abort: AbortController;
}

/** Прогон одной беседы. */
export interface RunningRun {
  /** Идентификатор вызова из окна: им же отменяют через RPC. */
  callId: string;
  conversation: string | null;
  startedAt: number;
  /** Отмена всего прогона — тот же сигнал, что получают инструменты. */
  abort: AbortController;
  /** Выполняющиеся инструменты по имени. */
  tools: Map<string, RunningTool>;
}


export class RunRegistry {
  private readonly runs = new Map<string, RunningRun>();

  /** Прогон начался. Повторный старт с тем же id заменяет прошлую запись. */
  start(callId: string, conversation: string | null, abort = new AbortController(), now = Date.now()): RunningRun {
    const run: RunningRun = { callId, conversation, startedAt: now, abort, tools: new Map() };
    this.runs.set(callId, run);
    return run;
  }

  /** Прогон кончился — как бы он ни кончился, записи не остаётся. */
  finish(callId: string): void {
    const run = this.runs.get(callId);
    if (!run) return;
    // Инструменты могли остаться запущенными, если прогон оборвался на середине:
    // гасим их контроллеры, иначе они переживут прогон.
    for (const tool of run.tools.values()) tool.abort.abort();
    run.tools.clear();
    this.runs.delete(callId);
  }

  /**
   * Инструмент начался. Его контроллер наследует отмену прогона: гаснет вслед за
   * родителем, но и сам может погасить только этот инструмент.
   */
  toolStart(callId: string, name: string, now = Date.now()): AbortController | null {
    const run = this.runs.get(callId);
    if (!run) return null;
    const abort = new AbortController();
    if (run.abort.signal.aborted) abort.abort();
    else run.abort.signal.addEventListener('abort', () => abort.abort(), { once: true });
    run.tools.set(name, { name, startedAt: now, abort });
    return abort;
  }

  /** Инструмент кончился (успешно или нет) — запись снимается. */
  toolFinish(callId: string, name: string): void {
    this.runs.get(callId)?.tools.delete(name);
  }

  /** Отмена по имени инструмента: `terminal: action cancel`. */
  abortTool(callId: string, name: string): boolean {
    const tool = this.runs.get(callId)?.tools.get(name);
    if (!tool) return false;
    tool.abort.abort();
    return true;
  }

  find(callId: string): RunningRun | undefined {
    return this.runs.get(callId);
  }

  /** Прогоны беседы — их может быть несколько, если окно перезапустилось. */
  forConversation(conversation: string): RunningRun[] {
    return [...this.runs.values()].filter((run) => run.conversation === conversation);
  }

  /** Остановить всё, что идёт. Возвращает число прогонов. */
  abortAll(): number {
    const runs = [...this.runs.values()];
    for (const run of runs) run.abort.abort();
    return runs.length;
  }

  /** Снимок для окна. Возраст считается здесь, а не в разметке. */
  snapshot(now = Date.now()): RunningSnapshot {
    return {
      runs: this.runs.size,
      tools: [...this.runs.values()]
        .filter((run) => run.tools.size > 0)
        .map((run) => ({
          callId: run.callId,
          conversation: run.conversation,
          names: [...run.tools.keys()],
          runningMs: Math.max(0, now - Math.min(...[...run.tools.values()].map((tool) => tool.startedAt))),
        })),
    };
  }
}

/**
 * Контроллер прогона поверх сигнала от вызывающего.
 *
 * Сигнал приходит из `ipc/router.ts`: им гасит окно. Но прогон могут погасить и
 * без ведома окна — «остановить всё» или `finish`, который снимает запись. Тогда
 * нужен свой контроллер, который гаснет и от одного, и от другого.
 */
export function abortOfRun(signal: AbortSignal): AbortController {
  const abort = new AbortController();
  if (signal.aborted) abort.abort();
  else signal.addEventListener('abort', () => abort.abort(), { once: true });
  return abort;
}
