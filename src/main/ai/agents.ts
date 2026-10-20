import {
  MAX_AGENT_MESSAGES,
  MAX_KEPT_AGENTS,
  MAX_LIVE_AGENTS,
  MAX_MESSAGE_CHARS,
  type AgentMessageFrom,
  type AgentSnapshot,
  type AgentStatus,
  type AgentStopReason,
} from '../../shared/agents';

/**
 * Реестр живых агентов (подзадач).
 *
 * Подзадача — это прогон модели со своим контекстом. Пока он идёт, наружу видна
 * только карточка «выполняется»: ни что агент делает, ни сколько шагов прошёл, ни
 * как его остановить. Реестр закрывает ровно это: у агента есть номер, состояние и
 * почта, а у человека и ведущего агента — способы посмотреть, поправить и снять.
 *
 * Что здесь есть и почему именно так:
 *
 *   - **Свой сигнал на каждого агента.** Прерывание человека снимает одного, а
 *     прерывание всего хода — всех: сигнал агента — потомок сигнала прогона. Иначе
 *     кнопка «остановить агента» гасила бы весь ход.
 *   - **Почта вместо перезапуска.** Сообщение не прерывает работу: агент читает его
 *     перед следующим шагом. Так длинное чтение не выбрасывается из-за одной
 *     поправки по курсу.
 *   - **Потолки.** Живых не больше `MAX_LIVE_AGENTS`: каждый — прогон модели, и
 *     «запусти ещё» иначе превращалось бы в «запусти двадцать». Завершённых держим
 *     `MAX_KEPT_AGENTS`, а новый ход начинается с чистого списка (`clearFinished`).
 *
 * Реестр — про процессы прогона, а не про Electron: проверяется без окна и без модели.
 */

/** Что можно сказать агенту и от кого: человек из панели или ведущий агент. */
export interface AgentMail {
  from: AgentMessageFrom;
  text: string;
}

/** Живой агент глазами того, кто его запустил. */
export interface AgentHandle {
  readonly id: string;
  readonly description: string;
  /** Сигнал агента: прерывание человека или всего хода. */
  readonly signal: AbortSignal;
  /** Чем агент занимается: имя инструмента или «думает». */
  note(patch: { activity?: string; steps?: number; toolCalls?: number }): void;
  /** Забрать пришедшие сообщения: агент зовёт это перед шагом. */
  drain(): AgentMail[];
  /** Почему агент остановлен; `null` — не остановлен. */
  readonly stopReason: AgentStopReason | null;
}

/** Итог отправки сообщения агенту. */
export interface AgentSendResult {
  ok: boolean;
  reason?: string;
}

/** Итог ожидания агентов. */
export interface AgentWaitResult {
  agents: AgentSnapshot[];
  /** Отчёты по номерам: есть только у завершённых. */
  reports: Map<string, string>;
  /** Время ожидания вышло — кто-то ещё работает. */
  timedOut: boolean;
}

export interface AgentRegistry {
  /**
   * Завести агента. `parent` — сигнал прогона: прерывание хода снимает и агентов.
   * Больше `MAX_LIVE_AGENTS` разом не запускаем — отказ словами, а не тихий пропуск.
   */
  spawn(options: { description: string; parent?: AbortSignal }): AgentHandle | { error: string };
  list(): AgentSnapshot[];
  snapshot(id: string): AgentSnapshot | null;
  /** Живой агент по номеру: через него прогон читает почту и узнаёт об остановке. */
  handle(id: string): AgentHandle | null;
  /** Закончить агента: состояние, короткий итог и полный отчёт для ждущих. */
  settle(id: string, status: AgentStatus, summary: string, report?: string): void;
  /** Отправить сообщение. Идущему — в почту, завершённому — отказ словами. */
  send(id: string, text: string, from: AgentMessageFrom): AgentSendResult;
  /** Остановить одного агента. `false` — уже не работает. */
  interrupt(id: string, by: AgentStopReason): boolean;
  /** Дождаться агентов; по времени — с честным «ещё работают». */
  wait(ids: readonly string[], timeoutMs: number): Promise<AgentWaitResult>;
  /** Забыть завершённых: новый ход начинается с пустого списка. */
  clearFinished(): void;
  /** Слушатель изменений: панель и push-события. Возвращает отписку. */
  onChange(listener: (agents: readonly AgentSnapshot[]) => void): () => void;
}

interface Entry {
  id: string;
  description: string;
  status: AgentStatus;
  startedAt: number;
  finishedAt?: number;
  steps: number;
  toolCalls: number;
  activity: string;
  summary?: string;
  report?: string;
  stoppedBy?: AgentStopReason;
  mail: AgentMail[];
  controller: AbortController;
  /** Разрешение ожидания: зовётся при завершении. */
  done: () => void;
  finished: Promise<void>;
}

export function createAgentRegistry(): AgentRegistry {
  const entries = new Map<string, Entry>();
  const listeners = new Set<(agents: readonly AgentSnapshot[]) => void>();
  let counter = 0;

  const snapshotOf = (entry: Entry): AgentSnapshot => ({
    id: entry.id,
    description: entry.description,
    status: entry.status,
    startedAt: entry.startedAt,
    steps: entry.steps,
    toolCalls: entry.toolCalls,
    activity: entry.activity,
    pending: entry.mail.length,
    ...(entry.finishedAt !== undefined ? { finishedAt: entry.finishedAt } : {}),
    ...(entry.summary ? { summary: entry.summary } : {}),
    ...(entry.stoppedBy ? { stoppedBy: entry.stoppedBy } : {}),
  });

  const list = (): AgentSnapshot[] => [...entries.values()].map(snapshotOf);

  const notify = (): void => {
    const agents = list();
    for (const listener of listeners) listener(agents);
  };

  /**
   * Снять агента с работы. Снимает только сигнал: состояние и итог выставит тот,
   * кто ведёт прогон агента (`settle`) — у него на руках отчёт и точное состояние.
   */
  const interruptEntry = (entry: Entry, by: AgentStopReason): boolean => {
    if (entry.status !== 'running') return false;
    entry.stoppedBy = by;
    entry.controller.abort();
    notify();
    return true;
  };

  /** Убрать самого старого завершённого: живых не трогаем никогда. */
  const prune = (): void => {
    const finished = [...entries.values()].filter((entry) => entry.status !== 'running');
    if (finished.length <= MAX_KEPT_AGENTS) return;
    finished.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    for (const entry of finished.slice(0, finished.length - MAX_KEPT_AGENTS)) entries.delete(entry.id);
  };

  const handleOf = (entry: Entry): AgentHandle => ({
    id: entry.id,
    description: entry.description,
    signal: entry.controller.signal,
    get stopReason(): AgentStopReason | null {
      return entry.stoppedBy ?? null;
    },
    note(patch): void {
      if (entry.status !== 'running') return;
      if (patch.activity !== undefined) entry.activity = patch.activity;
      if (patch.steps !== undefined) entry.steps = patch.steps;
      if (patch.toolCalls !== undefined) entry.toolCalls = patch.toolCalls;
      notify();
    },
    drain(): AgentMail[] {
      if (entry.mail.length === 0) return [];
      const mail = [...entry.mail];
      entry.mail = [];
      notify();
      return mail;
    },
  });

  return {
    spawn(options) {
      const live = [...entries.values()].filter((entry) => entry.status === 'running').length;
      if (live >= MAX_LIVE_AGENTS) {
        return {
          error:
            `Живых агентов уже ${live}, а больше ${MAX_LIVE_AGENTS} разом не запускаем: ` +
            'каждый — отдельный прогон модели. Дождись (wait_agent) или останови лишних (interrupt_agent).',
        };
      }
      counter += 1;
      const id = `agent-${counter}`;
      let resolve: () => void = () => {};
      const finished = new Promise<void>((done) => {
        resolve = done;
      });
      const entry: Entry = {
        id,
        description: options.description,
        // Заведённый агент уже идёт: `spawn` зовётся в момент запуска прогона, а
        // не заранее. Иначе между заведением и первым шагом он числился бы
        // остановленным — и панель показывала бы «остановлен» вместо «идёт».
        status: 'running',
        startedAt: Date.now(),
        steps: 0,
        toolCalls: 0,
        activity: '',
        mail: [],
        controller: new AbortController(),
        done: resolve,
        finished,
      };
      // Сигнал прогона — родитель сигнала агента: прерывание хода снимает агентов,
      // а прерывание агента ход не трогает. `addEventListener` без снятия: сигнал
      // живёт столько же, сколько прогон.
      const parent = options.parent;
      if (parent) {
        if (parent.aborted) interruptEntry(entry, 'run');
        else parent.addEventListener('abort', () => interruptEntry(entry, 'run'), { once: true });
      }
      entries.set(id, entry);
      prune();
      notify();
      return handleOf(entry);
    },

    list,

    snapshot(id) {
      const entry = entries.get(id);
      return entry ? snapshotOf(entry) : null;
    },

    handle(id) {
      const entry = entries.get(id);
      return entry ? handleOf(entry) : null;
    },

    settle(id, status, summary, report) {
      const entry = entries.get(id);
      if (!entry) return;
      entry.status = status;
      entry.summary = summary;
      if (report !== undefined) entry.report = report;
      if (status !== 'running' && entry.finishedAt === undefined) entry.finishedAt = Date.now();
      // Ожидание отпускаем только у завершённого: повторный `settle` ничего не ломает.
      if (status !== 'running') entry.done();
      // Предел держим и здесь: без этого завершённые копились бы сверх `MAX_KEPT_AGENTS`
      // до следующего запуска, и панель показывала бы лишнюю строку.
      prune();
      notify();
    },

    send(id, text, from) {
      const entry = entries.get(id);
      if (!entry) return { ok: false, reason: 'Такого агента нет' };
      if (entry.status !== 'running') {
        return {
          ok: false,
          reason:
            entry.status === 'done'
              ? 'Агент уже закончил: его отчёт читается через wait_agent, сообщение ему не нужно'
              : 'Агент больше не работает — сообщение некуда доставить',
        };
      }
      if (entry.mail.length >= MAX_AGENT_MESSAGES) {
        return {
          ok: false,
          reason:
            `У агента уже ${entry.mail.length} сообщений в очереди: он не успевает их читать. ` +
            'Дождись шага или отправь одно — но по делу',
        };
      }
      entry.mail.push({ from, text: text.slice(0, MAX_MESSAGE_CHARS) });
      notify();
      return { ok: true };
    },

    interrupt(id, by) {
      const entry = entries.get(id);
      return entry ? interruptEntry(entry, by) : false;
    },

    async wait(ids, timeoutMs) {
      const wanted = ids.map((id) => entries.get(id)).filter((entry): entry is Entry => entry !== undefined);
      const pending = wanted.filter((entry) => entry.status === 'running').map((entry) => entry.finished);
      let timedOut = false;
      if (pending.length > 0) {
        timedOut = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(true), Math.max(0, timeoutMs));
          void Promise.all(pending).then(() => {
            clearTimeout(timer);
            resolve(false);
          });
        });
      }
      const reports = new Map<string, string>();
      for (const entry of wanted) {
        if (entry.report !== undefined) reports.set(entry.id, entry.report);
      }
      return {
        agents: wanted.map(snapshotOf),
        reports,
        timedOut: timedOut && wanted.some((entry) => entry.status === 'running'),
      };
    },

    clearFinished() {
      let changed = false;
      for (const [id, entry] of entries) {
        if (entry.status === 'running') continue;
        entries.delete(id);
        changed = true;
      }
      if (changed) notify();
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
