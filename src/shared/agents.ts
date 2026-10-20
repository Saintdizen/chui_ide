import type { ChatUsage } from './api';
import { clipDescription } from './subagents';

/**
 * Живые агенты: кто работает, что делает и как его остановить.
 *
 * Подзадача (`task`) ждёт отчёта: пока она идёт, человек видит только карточку
 * «выполняется» и итог в конце. С `workflow` агентов запускают пачкой, и это стало
 * заметно: три-четыре прогона модели работают разом, а в ленте — одна строка.
 * Отсюда три вещи, которых не было:
 *
 *   1. Реестр. У каждого агента номер, описание, состояние, шаги и то, чем он занят
 *      прямо сейчас. По номеру к нему обращаются инструменты и панель.
 *   2. Агент в фоне (`spawn_agent`). Запустить и не ждать: пока он работает, можно
 *      читать, спрашивать и решать, нужен ли он вообще.
 *   3. Разговор с агентом. Сообщение (от человека или от ведущего агента) доезжает
 *      до него перед следующим шагом — длинную работу не надо обрывать, чтобы
 *      поправить курс. Остановить тоже можно по одному, не снимая остальных.
 *
 * Здесь только то, что решается без процессов: форма записи, потолки, подписи и
 * разбор аргументов инструментов. Сам реестр живёт в main (`ai/agents.ts`): ему
 * нужны прерывания и ожидание, а это уже исполнение.
 *
 * Чего сознательно нет: агенты не видят друг друга и не зовут друг друга — глубина
 * всегда 1 (см. `SUBAGENT_TOOLS`). Иначе один вопрос человека превращался бы в
 * дерево прогонов модели, за которое никто не считал.
 */

/** Состояние агента. `stopped` — его сняли, а не он сломался. */
export type AgentStatus = 'running' | 'done' | 'failed' | 'stopped';

/** Кто снял агента с работы. `run` — кончился или прерван весь ход. */
export type AgentStopReason = 'human' | 'model' | 'run';

/** Автор сообщения агенту: человек из панели или ведущий агент инструментом. */
export type AgentMessageFrom = 'human' | 'agent';

/** Сообщение в почте агента: доезжает перед следующим шагом. */
export interface AgentMessage {
  from: AgentMessageFrom;
  text: string;
}

/**
 * Что видно об агенте: панель и инструменты показывают одно и то же.
 *
 * Ни текста задания, ни отчёта целиком здесь нет: задание может быть длинным, а
 * отчёт уходит тому, кто его ждёт (`wait_agent`). Панели хватает описания и итога.
 */
export interface AgentSnapshot {
  id: string;
  description: string;
  status: AgentStatus;
  /** Время запуска (мс от эпохи): по нему видно, сколько уже идёт. */
  startedAt: number;
  finishedAt?: number;
  /** Сколько шагов модели сделано. */
  steps: number;
  /** Сколько вызовов инструментов сделано. */
  toolCalls: number;
  /** Чем занят: имя инструмента на последнем шаге или чем закончил. */
  activity: string;
  /** Сколько сообщений ждёт передачи (агент ещё не дошёл до шага). */
  pending: number;
  /** Короткий итог завершённого: одна строка для панели. */
  summary?: string;
  /** Кто остановил — только у `stopped`. */
  stoppedBy?: AgentStopReason;
  /** Расход агента: виден и тогда, когда он дорос до конца уже после хода. */
  usage?: ChatUsage;
}

/* ── потолки ──────────────────────────────────────────────────────────────
 *
 * Реестр — про живое, а не про историю: агент стоит прогона модели, и десяток
 * одновременно опустошает не только окно, но и счёт. Потолки здесь не для
 * красоты: без них «запусти ещё» превращается в «запусти двадцать».
 */

/** Сколько агентов может работать одновременно. */
export const MAX_LIVE_AGENTS = 6;

/** Сколько сообщений ждёт агента: больше — он всё равно не успеет прочитать. */
export const MAX_AGENT_MESSAGES = 5;

/** Потолок одного сообщения агенту. */
export const MAX_MESSAGE_CHARS = 2000;

/** Сколько завершённых агентов помним: панель — не архив прогонов. */
export const MAX_KEPT_AGENTS = 12;

/** Сколько ждём по умолчанию и максимум (`wait_agent`). */
export const WAIT_DEFAULT_MS = 120_000;
export const WAIT_MAX_MS = 300_000;

/** Потолок текста списка для модели: строк на агента немного, но их может быть много. */
export const MAX_LIST_CHARS = 6000;

/** Подпись состояния для человека: коротко и без «успешно завершился». */
export function agentStatusLabel(status: AgentStatus): string {
  if (status === 'running') return 'идёт';
  if (status === 'done') return 'готово';
  if (status === 'failed') return 'сбой';
  return 'остановлен';
}

/** Склонение по числу — как в остальных подписях проекта. */
function plural(count: number, one: string, few: string, many: string): string {
  const tail = count % 100;
  if (tail >= 11 && tail <= 14) return many;
  const last = count % 10;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

/** Минуты и секунды словами: «1 мин 20 с», «14 с». */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} мин` : `${minutes} мин ${rest} с`;
}

/** Одна строка об агенте: номер, описание, состояние и чем занят. */
export function formatAgentLine(agent: AgentSnapshot, now = Date.now()): string {
  const parts = [`${agent.id} «${agent.description}» — ${agentStatusLabel(agent.status)}`];
  if (agent.status === 'running') {
    parts.push(`идёт ${formatElapsed(now - agent.startedAt)}`);
  }
  if (agent.steps > 0) parts.push(`шагов ${agent.steps}`);
  if (agent.toolCalls > 0) parts.push(`вызовов ${agent.toolCalls}`);
  if (agent.pending > 0) parts.push(`сообщений в очереди ${agent.pending}`);
  const tail = agent.summary?.trim();
  if (tail) parts.push(tail);
  else if (agent.status === 'running' && agent.activity) parts.push(`сейчас: ${agent.activity}`);
  return parts.join(', ');
}

/** Почему агент снят с работы — словами для панели и отчёта. */
export function stopReasonLabel(reason: AgentStopReason): string {
  if (reason === 'human') return 'остановлен человеком';
  if (reason === 'model') return 'остановлен ведущим агентом';
  return 'снят вместе с ходом';
}

/**
 * Что делает агент прямо сейчас — для подписи в панели. У завершённого это
 * последний итог: без пометки он читался бы как «всё ещё работает».
 */
export function agentActivityLabel(agent: AgentSnapshot): string {
  if (agent.status !== 'running') return agent.summary?.trim() || agentStatusLabel(agent.status);
  return agent.activity ? `сейчас: ${agent.activity}` : 'думает';
}

/**
 * Список для модели (`list_agents`).
 *
 * Пустой ответ говорит словами, что агентов нет, — иначе модель читает пустоту как
 * «инструмент сломался» и пробует ещё раз.
 */
export function formatAgentList(agents: readonly AgentSnapshot[], now = Date.now()): string {
  if (agents.length === 0) {
    return 'Агентов нет: сейчас никто не работает. Запустить — spawn_agent, дождаться — wait_agent.';
  }
  const running = agents.filter((agent) => agent.status === 'running').length;
  const lines: string[] = [
    `Агентов: ${agents.length}, из них работают ${running} ${plural(running, 'агент', 'агента', 'агентов')}.`,
  ];
  for (const agent of agents) lines.push(`- ${formatAgentLine(agent, now)}`);
  const text = lines.join('\n');
  return text.length > MAX_LIST_CHARS ? `${text.slice(0, MAX_LIST_CHARS)}\n… (список обрезан)` : text;
}

/**
 * Сообщение, которое агент читает перед шагом. Рамка нужна, чтобы модель поняла:
 * это уточнение по ходу дела, а не новое задание поверх старого.
 */
export function formatAgentNotes(notes: readonly AgentMessage[]): string {
  const lines = notes.map((note) =>
    note.from === 'human' ? `- от человека: ${note.text}` : `- от ведущего агента: ${note.text}`,
  );
  return [
    'Пока ты работал, пришли уточнения. Учти их в оставшейся работе; если они отменяют',
    'задание — закончи коротким отчётом о том, что уже сделано.',
    ...lines,
  ].join('\n');
}

/** Итог ожидания агента (`wait_agent`): отчёт или честное «ещё идёт». */
export interface AgentWaitOutcome {
  agent: AgentSnapshot;
  /** Отчёт: есть у завершённого, у идущего — `null`. */
  report: string | null;
}

/**
 * Ответ инструмента `wait_agent`.
 *
 * Идущий агент — не ошибка: время ожидания вышло, работа продолжается. Так и
 * говорим, вместе с тем, что уже известно, — иначе модель решает, что агент
 * потерялся, и запускает второй.
 */
export function formatAgentWaits(outcomes: readonly AgentWaitOutcome[], timedOut: boolean): string {
  const parts: string[] = [];
  for (const outcome of outcomes) {
    const head = `${outcome.agent.id} «${outcome.agent.description}» — ${agentStatusLabel(outcome.agent.status)}`;
    parts.push(outcome.report === null ? `## ${head}` : `## ${head}\n${outcome.report.trim()}`);
  }
  if (timedOut) {
    parts.push('Ожидание истекло: эти агенты ещё работают. Их состояние — list_agents, отчёт — wait_agent позже.');
  }
  return parts.join('\n\n');
}

/* ── разбор аргументов ──────────────────────────────────────────────────────
 *
 * Модель называет агентов по номеру из `list_agents`/`spawn_agent`. Номер бывает с
 * опечаткой (длинный id сокращают), поэтому принимаем и точное совпадение, и
 * единственное совпадение по началу — но не «примерно этот»: остановить не того
 * агента хуже, чем сказать, что такого нет.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Номер агента из аргумента: строка без пробелов. Пусто — номера нет. */
function agentIdOf(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/** Найти агента по названному номеру среди известных. */
export function findAgentId(named: string, known: readonly string[]): { id: string | null; error?: string } {
  if (!named) return { id: null, error: 'Нужен номер агента — он есть в list_agents.' };
  if (known.includes(named)) return { id: named };
  const prefixed = known.filter((id) => id.startsWith(named));
  if (prefixed.length === 1) return { id: prefixed[0]! };
  if (prefixed.length > 1) {
    return {
      id: null,
      error: `Под «${named}» подходят сразу несколько агентов: ${prefixed.join(', ')}. Назови точный номер.`,
    };
  }
  return { id: null, error: `Агента «${named}» нет. Кто есть — list_agents.` };
}

/** Разбор `wait_agent`: номера и сколько ждать. Один номер тоже понимаем. */
export interface WaitRequest {
  ids: string[];
  timeoutMs: number;
  error?: string;
}

export function parseWaitRequest(args: Record<string, unknown>, known: readonly string[]): WaitRequest {
  const single = agentIdOf(args.id);
  const raw = args.ids;
  const named: string[] = [];
  if (single) named.push(single);
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const id = agentIdOf(item);
      if (id) named.push(id);
    }
  }
  if (named.length === 0) {
    return { ids: [], timeoutMs: 0, error: 'Нужны номера агентов: id или ids — список номеров из list_agents.' };
  }

  const ids: string[] = [];
  for (const name of named) {
    const found = findAgentId(name, known);
    if (found.error) return { ids: [], timeoutMs: 0, error: found.error };
    if (!ids.includes(found.id!)) ids.push(found.id!);
  }

  const seconds = typeof args.timeout === 'number' && Number.isFinite(args.timeout) ? args.timeout : 0;
  const timeoutMs = seconds > 0 ? Math.min(WAIT_MAX_MS, Math.round(seconds * 1000)) : WAIT_DEFAULT_MS;
  return { ids, timeoutMs };
}

/** Разбор `send_message`: кому и что. */
export interface MessageRequest {
  id: string | null;
  text: string;
  error?: string;
}

export function parseMessageRequest(args: Record<string, unknown>, known: readonly string[]): MessageRequest {
  const found = findAgentId(agentIdOf(args.id), known);
  if (found.error) return { id: null, text: '', error: found.error };
  const text = typeof args.text === 'string' ? args.text.replace(/\s+$/, '') : '';
  if (!text.trim()) return { id: found.id, text: '', error: 'Нужен текст сообщения агенту.' };
  if (text.length > MAX_MESSAGE_CHARS) {
    return { id: found.id, text: '', error: `Сообщение длиннее ${MAX_MESSAGE_CHARS} символов — сократи до сути.` };
  }
  return { id: found.id, text };
}

/** Разбор `interrupt_agent`: чей номер. */
export function parseInterruptRequest(
  args: Record<string, unknown>,
  known: readonly string[],
): { id: string | null; error?: string } {
  return findAgentId(agentIdOf(args.id), known);
}

/** Разбор `spawn_agent`: описание и задание. */
export interface SpawnRequest {
  description: string;
  prompt: string;
  error?: string;
}

export function parseSpawnRequest(args: Record<string, unknown>): SpawnRequest {
  const record = asRecord(args) ?? {};
  const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : '';
  if (!prompt) {
    return { description: '', prompt: '', error: 'Нужно задание агенту: prompt — что именно исследовать.' };
  }
  return { description: clipDescription(record.description), prompt };
}
