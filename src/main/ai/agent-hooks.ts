/**
 * Запуск хуков проекта: скрипт получает вызов инструмента JSON-ом на stdin и
 * отвечает JSON-ом на stdout. Соглашение — как у git-хуков: код выхода 0 —
 * «пускать», не 0 — «не пускать», а причина берётся из stdout/stderr.
 *
 * Здесь только процесс и разбор ответа; кто и когда зовёт — `agent-tools.ts`,
 * какие хуки есть и что значит `match` — `shared/agent-hooks.ts`.
 */
import { spawn } from 'node:child_process';

import {
  type AgentHookConfig,
  type AgentHookEvent,
  DEFAULT_HOOK_TIMEOUT_MS,
  hookMatchesTool,
  MAX_HOOK_TEXT_CHARS,
} from '../../shared/agent-hooks';

/** Вызов инструмента, каким его видит хук. */
export interface AgentHookCall {
  tool: string;
  args: unknown;
}

/** Что вернул инструмент — для хуков после вызова. */
export interface AgentHookOutcome {
  ok: boolean;
  summary: string;
}

/** Строка, которую хук дописал к результату. */
export interface AgentHookNote {
  hook: string;
  text: string;
}

export interface AgentHookVerdict {
  /** Заполнено — вызов не состоялся, текст уходит модели вместо результата. */
  deny?: string;
  notes: AgentHookNote[];
}

export interface AgentHooks {
  before(call: AgentHookCall): Promise<AgentHookVerdict>;
  after(call: AgentHookCall, outcome: AgentHookOutcome): Promise<AgentHookNote[]>;
}

export interface AgentHooksOptions {
  hooks: readonly AgentHookConfig[];
  /** Рабочий каталог проекта: скрипт ищет свои файлы относительно него. */
  cwd: string;
  /** Предел времени на весь вызов: шаг не должен ждать сотню хуков. */
  signal?: AbortSignal;
}

export const NO_HOOKS: AgentHooks = {
  before: async () => ({ notes: [] }),
  after: async () => [],
};

/** Что скрипт сказал JSON-ом: и отказ, и приписка, и то и другое сразу. */
interface HookAnswer {
  deny?: string;
  note?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Ответ хука не должен съесть промпт: режем по символам и с многоточием. */
function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_HOOK_TEXT_CHARS ? `${trimmed.slice(0, MAX_HOOK_TEXT_CHARS)}…` : trimmed;
}

/** Сколько символов stdout/stderr держим в памяти: остальное не нужно никому. */
const MAX_CAPTURE_CHARS = 4_000;

interface HookRunResult {
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Один запуск скрипта. Ошибка запуска и таймаут — не повод падать: хук говорит
 * «мнения нет», а не «запрещаю» (см. шапку `shared/agent-hooks.ts`).
 */
function runHook(
  hook: AgentHookConfig,
  event: AgentHookEvent,
  payload: unknown,
  options: AgentHooksOptions,
): Promise<HookRunResult> {
  return new Promise((resolve) => {
    const timeoutMs = hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ code, timedOut, stdout, stderr });
    };

    // Шелл — платформенный: на Windows `/bin/sh` нет, `spawn` молча падал в ENOENT,
    // и раннер считал, что хук промолчал, — то есть все проверки тихо разрешали вызов.
    // `timeout` у spawn не используем: убийство дерева процессов ниже — наше, и два
    // таймера спорили бы, какой из них первый.
    const child = spawn(hook.command, {
      cwd: options.cwd,
      env: { ...process.env, CHUI_HOOK: hook.name, CHUI_HOOK_EVENT: event },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);

    const onAbort = (): void => {
      child.kill('SIGKILL');
      finish(null);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE_CHARS) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURE_CHARS) stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      stderr += `\n${String(error)}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));

    // Скрипт может не читать stdin вовсе: `EPIPE` тут — обычное дело.
    child.stdin?.on('error', () => undefined);
    // Всё, что знает хук, — JSON: аргументы, а после вызова — и результат.
    child.stdin?.end(`${JSON.stringify(payload)}\n`);
  });
}

/** Разбор ответа: JSON, если он там есть; иначе просто текст. */
function parseAnswer(stdout: string): HookAnswer {
  const text = stdout.trim();
  if (!text) return {};
  if (text.startsWith('{')) {
    try {
      const record = asRecord(JSON.parse(text) as unknown);
      if (record) {
        const deny = asText(record.reason) || (record.decision === 'deny' ? 'Запрещено хуком' : '');
        const note = asText(record.note) || asText(record.message);
        return { ...(deny ? { deny: clip(deny) } : {}), ...(note ? { note: clip(note) } : {}) };
      }
    } catch {
      // Не JSON — считаем текстом ниже.
    }
  }
  return { note: clip(text) };
}

/**
 * Собирает раннер из настроек: фильтр по имени инструмента и события — здесь,
 * чтобы `agent-tools.ts` не знал ничего про `match`.
 */
export function createAgentHooks(options: AgentHooksOptions): AgentHooks {
  const hooks = options.hooks.filter((hook) => hook.enabled !== false);
  if (hooks.length === 0) return NO_HOOKS;

  const pick = (event: AgentHookEvent, tool: string): AgentHookConfig[] =>
    hooks.filter((hook) => hook.event === event && hookMatchesTool(hook, tool));

  return {
    async before(call) {
      const notes: AgentHookNote[] = [];
      for (const hook of pick('before-tool', call.tool)) {
        const result = await runHook(
          hook,
          'before-tool',
          { event: 'before-tool', tool: call.tool, args: call.args, cwd: options.cwd },
          options,
        );
        if (result.timedOut || result.code === null) continue;
        const answer = parseAnswer(result.stdout);
        // Код выхода — главный голос: не 0 значит «не пускать».
        if (result.code !== 0) {
          const reason = answer.deny ?? answer.note ?? asText(result.stderr) ?? '';
          return { deny: `Запрещено хуком \`${hook.name}\`: ${clip(reason) || `код выхода ${result.code}`}`, notes };
        }
        if (answer.deny) return { deny: `Запрещено хуком \`${hook.name}\`: ${answer.deny}`, notes };
        if (answer.note) notes.push({ hook: hook.name, text: answer.note });
      }
      return { notes };
    },

    async after(call, outcome) {
      const notes: AgentHookNote[] = [];
      for (const hook of pick('after-tool', call.tool)) {
        const payload = {
          event: 'after-tool',
          tool: call.tool,
          args: call.args,
          cwd: options.cwd,
          outcome: { ok: outcome.ok, summary: outcome.summary.slice(0, MAX_CAPTURE_CHARS) },
        };
        const result = await runHook(hook, 'after-tool', payload, options);
        if (result.timedOut || result.code === null) continue;
        const answer = parseAnswer(result.stdout);
        const text = answer.note ?? answer.deny ?? asText(result.stderr);
        if (text) notes.push({ hook: hook.name, text: clip(text) });
      }
      return notes;
    },
  };
}
