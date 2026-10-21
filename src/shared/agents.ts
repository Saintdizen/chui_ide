import type { ChatUsage } from './api';

/**
 * Живые агенты: кто работает, что делает и как его остановить.
 *
 * Подзадача (`task`) ждёт отчёта: пока она идёт, человек видит только карточку
 * «выполняется» и итог в конце. Пачкой агентов запускают `task` с несколькими
 * заданиями и `agents`, и это стало
 * заметно: три-четыре прогона модели работают разом, а в ленте — одна строка.
 * Отсюда три вещи, которых не было:
 *
 *   1. Реестр. У каждого агента номер, описание, состояние, шаги и то, чем он занят
 *      прямо сейчас. По номеру к нему обращаются инструменты и панель.
 *   2. Агент в фоне (`agents` с `action: "spawn"`). Запустить и не ждать: пока он работает, можно
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
 * отчёт уходит тому, кто его ждёт (`agents` с `action: "wait"`). Панели хватает описания и итога.
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

/** Сколько ждём по умолчанию и максимум (`action: "wait"`). */
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
 * Список для модели (`agents` с `action: "list"`).
 *
 * Пустой ответ говорит словами, что агентов нет, — иначе модель читает пустоту как
 * «инструмент сломался» и пробует ещё раз.
 */
export function formatAgentList(agents: readonly AgentSnapshot[], now = Date.now()): string {
  if (agents.length === 0) {
    return 'Агентов нет: сейчас никто не работает. Запустить — agents с action: "spawn", дождаться — action: "wait".';
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
