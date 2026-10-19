import { fork, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RUN_CODE_DEFAULT_TIMEOUT_MS,
  RUN_CODE_MAX_CALLS,
  RUN_CODE_MAX_LOGS,
  RUN_CODE_MAX_TIMEOUT_MS,
  clampProgramText,
  programModule,
  programProblem,
  type ProgramMode,
  type RunCodeAgentCall,
  type RunCodeCall,
  type RunCodeOutcome,
} from '../../shared/run-code';
import { clipDescription } from '../../shared/subagents';
import { WORKFLOW_MAX_AGENTS, WORKFLOW_MAX_PARALLEL, createAgentGate, workflowProblem } from '../../shared/workflow';
import { HARNESS_SOURCE } from './run-code-harness';

/**
 * Запуск программы агента (`run_code`) и сценария с агентами (`workflow`).
 *
 * Оба режима идут одним путём: отдельный процесс, канал IPC в main, обрыв по
 * времени. Разница в том, что видит исполняемый код: программе даны `tools` —
 * вызовы инструментов сессии, а сценарию — `agents` — подчинённые агенты (см.
 * `shared/workflow.ts`). Один движок на два инструмента: второго такого места,
 * где чужой код ждёт ответа от main, быть не должно.
 *
 * Чужой код идёт отдельным процессом, а не в main: он может зависнуть, упасть или
 * напечатать мегабайты. Инструменты остаются в main и зовутся по каналу IPC —
 * значит права, подтверждения и запись правок идут тем же путём, что у обычных
 * вызовов.
 *
 * Три ограничения, без которых это было бы опасно:
 *
 * 1. **Файловая система.** Процесс запускается с моделью прав Node
 *    (`--permission`): читать можно проект и папку запуска, писать — только в
 *    папку запуска. Значит `readFile('/home/…/.ssh/id_rsa')` программе не
 *    удастся, а изменения проекта идут через инструменты — с ревью и undo.
 * 2. **Потомки.** Модель прав по умолчанию запрещает `child_process` и воркеры:
 *    запустить что-то ещё из программы нельзя. Для команд есть инструменты.
 * 3. **Время и число вызовов.** Предел времени и предел вызовов: программа
 *    может уйти в бесконечный цикл, и агент не должен ждать её вечно. У сценария
 *    к пределу вызовов добавляется предел агентов: каждый — прогон модели.
 *
 * Песочница контейнера сюда не подмешивается: программа Node в контейнере без
 * инструментов бесполезна, а запускать её на хосте при включённой песочнице —
 * значит обойти обещание песочницы. Поэтому при включённой песочнице инструмент
 * просто не предлагается (см. `canRun` в service).
 */

/**
 * Можно ли вообще запустить программу.
 *
 * Две причины отказа, и обе честные. Песочница: программа Node в контейнере без
 * инструментов бесполезна, а запущенная на хосте при включённой песочнице — обход
 * её обещания. Старый рантайм: без модели прав Node (`--permission`, с 20)
 * программе были бы открыты чужие файлы, а это уже не «вызов инструмента».
 */
export function canRunProgram(sandboxEnabled: boolean): boolean {
  if (sandboxEnabled) return false;
  const major = Number(/^v?(\d+)/.exec(process.versions.node)?.[1] ?? '');
  return Number.isFinite(major) && major >= 20;
}

/** Что инструмент `run_code` даёт программе и чего ждёт взамен. */
export interface RunCodeRunOptions {
  /** Корень проекта: что программе разрешено читать. */
  root: string;
  /**
   * Что исполняем: программу с инструментами (`code`) или сценарий с агентами
   * (`workflow`). От режима зависят проверка исходника, имена в контексте и то,
   * какой канал работает — `tools` или `agents`.
   */
  program?: ProgramMode;
  /** Отмена прогона («Стоп»). */
  signal?: AbortSignal;
  timeoutMs?: number;
  maxCalls?: number;
  /** Вызов инструмента. Здесь живёт вся политика прав — main решает сам. */
  onCall?: (name: string, args: unknown) => Promise<{ ok: boolean; summary: string; text: string }>;
  /**
   * Запуск подчинённого агента из сценария. Кто такой агент и сколько их можно —
   * решает тот, кто передал вызов; здесь только счёт и очередь.
   */
  onAgent?: (request: {
    description: string;
    prompt: string;
  }) => Promise<{ ok: boolean; summary: string; text: string }>;
  /** Сколько агентов сценарий может запустить за раз. */
  maxAgents?: number;
  /** Сколько агентов идут одновременно. */
  maxParallel?: number;
  /** Подмена запуска в тестах: путь к исполняемому файлу node. */
  execPath?: string;
  /** Версия рантайма — от неё зависит имя флага модели прав. */
  runtimeVersion?: string;
  /** Свой предел вывода программы: в тестах удобно уменьшить. */
  maxLogs?: number;
}

/**
 * Флаги модели прав Node для запуска программы.
 *
 * Имя флага менялось: до 23.5 это `--experimental-permission`, дальше
 * `--permission`. Поля `--allow-fs-read` и `--allow-fs-write` те же.
 */
export function runtimePermissionArgs(
  version: string,
  paths: { read: readonly string[]; write: readonly string[] },
): string[] {
  const major = Number(/^v?(\d+)/.exec(version.trim())?.[1] ?? '');
  if (!Number.isFinite(major) || major < 20) return [];
  const flag = major >= 23 ? '--permission' : '--experimental-permission';
  const args = [flag];
  // По флагу на каждый путь. Список через запятую одним флагом Node 22 понимает
  // как ОДИН путь (проверено: чтение падало с «access restricted»), поэтому
  // повторяем флаг — так работает и на 22, и на 24.
  for (const read of paths.read) args.push(`--allow-fs-read=${read}`);
  for (const write of paths.write) args.push(`--allow-fs-write=${write}`);
  return args;
}

/** Ответ инструмента внутрь программы: и итог, и текст — как у обычного вызова. */
interface Reply {
  ok: boolean;
  summary: string;
  text: string;
}

export async function runProgram(source: string, options: RunCodeRunOptions): Promise<RunCodeOutcome> {
  const program: ProgramMode = options.program ?? 'code';
  const problem = program === 'workflow' ? workflowProblem(source) : programProblem(source);
  if (problem) return failed(problem);

  const startedAt = Date.now();
  const timeoutMs = Math.min(
    Math.max(options.timeoutMs ?? RUN_CODE_DEFAULT_TIMEOUT_MS, 1_000),
    RUN_CODE_MAX_TIMEOUT_MS,
  );
  const maxCalls = options.maxCalls ?? RUN_CODE_MAX_CALLS;
  const maxLogs = options.maxLogs ?? RUN_CODE_MAX_LOGS;
  const maxAgents = options.maxAgents ?? WORKFLOW_MAX_AGENTS;
  /** Очередь на одновременность: `Promise.all` сценария не должен упираться в предел провайдера. */
  const throughGate = createAgentGate(options.maxParallel ?? WORKFLOW_MAX_PARALLEL);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-run-code-'));
  const programPath = path.join(dir, 'program.mjs');
  const harnessPath = path.join(dir, 'harness.mjs');

  let child: ChildProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  const calls: RunCodeCall[] = [];
  const agents: RunCodeAgentCall[] = [];
  /** Занятые места под агентов: занимаем до `await`, иначе пачка разом обошла бы предел. */
  let agentSlots = 0;
  let agentsExceeded = false;
  let callsExceeded = false;
  let timedOut = false;
  let settled = false;

  /** Убрать за собой: папка запуска живёт ровно столько, сколько программа. */
  const cleanup = async (): Promise<void> => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    await fs.writeFile(programPath, programModule(source, program), 'utf8');
    await fs.writeFile(harnessPath, HARNESS_SOURCE, 'utf8');

    const roots = await allowedPaths(options.root, dir);

    return await new Promise<RunCodeOutcome>((resolve) => {
      const execPath = options.execPath ?? process.execPath;
      const version = options.runtimeVersion ?? process.versions.node;
      const stdio: Array<'ignore' | 'pipe' | 'ipc'> = ['ignore', 'pipe', 'pipe', 'ipc'];

      const started = fork(harnessPath, [programPath, program], {
        execPath,
        // Свой набор флагов: чужие (например, от vitest) в чужом процессе не нужны.
        execArgv: runtimePermissionArgs(version, roots),
        // Модель прав сама по себе не работает без ELECTRON_RUN_AS_NODE, когда
        // исполняемый файл — сам редактор: иначе он попытается открыть окно.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
        stdio,
        cwd: roots.root,
      });
      child = started;

      let stdout = '';
      let stderr = '';
      const collect = (chunk: Buffer): void => {
        // Программа печатает через console (его мы забираем в обвязке), но может
        // писать и в поток напрямую. Держим хвост: он объясняет падения.
        stdout = (stdout + chunk.toString('utf8')).slice(-4_000);
      };
      started.stdout?.on('data', collect);
      started.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-4_000);
      });

      const finish = (outcome: RunCodeOutcome): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        resolve(outcome);
      };

      const kill = (): void => {
        try {
          started.kill('SIGKILL');
        } catch {
          // процесс уже умер — это нормально
        }
      };

      const onAbort = (): void => {
        timedOut = false;
        kill();
        finish({
          logs: '',
          calls,
          ms: Date.now() - startedAt,
          timedOut: false,
          truncated: false,
          error: 'прогон прерван',
          ...agentFields(),
        });
      };

      /** Поля сценария в итоге: агенты и отметка о том, что предел сработал. */
      const agentFields = (): Partial<RunCodeOutcome> => ({
        ...(agents.length > 0 ? { agents } : {}),
        ...(agentsExceeded ? { agentsExceeded: true } : {}),
      });

      timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener('abort', onAbort, { once: true });

      started.on('message', (message: unknown) => {
        const data = message as {
          kind?: string;
          id?: number;
          name?: string;
          args?: unknown;
          prompt?: string;
          description?: string;
          value?: string;
          logs?: string[];
          message?: string;
          stack?: string;
        };
        if (!data || typeof data !== 'object') return;

        if (data.kind === 'call') {
          void handleCall(data.id ?? 0, String(data.name ?? ''), data.args);
          return;
        }

        if (data.kind === 'agent') {
          void handleAgent(data.id ?? 0, String(data.prompt ?? ''), data.description);
          return;
        }

        if (data.kind === 'done') {
          const logs = joinLogs(data.logs ?? [], maxLogs);
          const value = clampProgramText(data.value ?? '');
          finish({
            ...(data.value !== undefined ? { value: value.text } : {}),
            logs: logs.text,
            calls,
            ms: Date.now() - startedAt,
            timedOut: false,
            truncated: logs.truncated || value.truncated,
            ...agentFields(),
            ...(callsExceeded ? { callsExceeded: true } : {}),
          });
          kill();
          return;
        }

        if (data.kind === 'error') {
          const logs = joinLogs(data.logs ?? [], maxLogs);
          finish({
            logs: logs.text,
            calls,
            ms: Date.now() - startedAt,
            timedOut: false,
            truncated: logs.truncated,
            error: String(data.message ?? 'неизвестная ошибка'),
            ...(data.stack ? { stack: String(data.stack).split('\n').slice(0, 6).join('\n') } : {}),
            ...agentFields(),
            ...(callsExceeded ? { callsExceeded: true } : {}),
          });
          kill();
        }
      });

      /** Вызов инструмента из программы: считаем, ограничиваем, исполняем. */
      async function handleCall(id: number, name: string, args: unknown): Promise<void> {
        if (calls.length >= maxCalls) {
          callsExceeded = true;
          reply(id, {
            ok: false,
            summary: `предел вызовов в программе: ${maxCalls}`,
            text: `Программа уже сделала ${maxCalls} вызовов инструментов — предел на один запуск. Собери программу короче или верни то, что уже есть.`,
          });
          return;
        }

        const callStartedAt = Date.now();
        let result: Reply;
        if (!options.onCall) {
          reply(id, {
            ok: false,
            summary: 'инструменты недоступны',
            text: 'В сценарии инструментов нет: читать и править проект умеют run_code и агенты.',
          });
          return;
        }
        try {
          result = await options.onCall(name, args);
        } catch (error) {
          result = { ok: false, summary: `отказ: ${describe(error)}`, text: describe(error) };
        }
        calls.push({
          name,
          ok: result.ok,
          summary: result.summary,
          ms: Date.now() - callStartedAt,
        });
        reply(id, result);
      }

      /**
       * Агент из сценария (`workflow`): считаем, ограничиваем, запускаем.
       *
       * Место под агента занимаем сразу, до первого `await`: пачка из
       * `agents.parallel` приходит одним залпом, и проверка «сколько уже запущено»
       * после ожидания пропустила бы всю пачку целиком.
       */
      async function handleAgent(id: number, prompt: string, description?: string): Promise<void> {
        const text = prompt.trim();
        if (!options.onAgent) {
          reply(id, {
            ok: false,
            summary: 'агенты недоступны',
            text: 'Агентов запускает только сценарий (workflow): в программе их нет.',
          });
          return;
        }
        if (!text) {
          reply(id, {
            ok: false,
            summary: 'пустое задание агенту',
            text: 'У агента нет задания: в agents.run нужен непустой prompt — что именно он должен выяснить.',
          });
          return;
        }
        if (agentSlots >= maxAgents) {
          agentsExceeded = true;
          reply(id, {
            ok: false,
            summary: `предел агентов в сценарии: ${maxAgents}`,
            text:
              `Сценарий уже запустил ${maxAgents} агентов — предел на один запуск. ` +
              'Каждый агент — отдельный прогон модели, поэтому работай с теми отчётами, что уже есть, ' +
              'и верни результат, а остальное сделай следующим вызовом workflow.',
          });
          return;
        }

        agentSlots += 1;
        const label = clipDescription(description ?? text, 'агент');
        const agentStartedAt = Date.now();
        let result: Reply;
        try {
          result = await throughGate(() => options.onAgent!({ description: label, prompt: text }));
        } catch (error) {
          result = { ok: false, summary: `отказ: ${describe(error)}`, text: describe(error) };
        }
        agents.push({ description: label, ok: result.ok, summary: result.summary, ms: Date.now() - agentStartedAt });
        reply(id, result);
      }

      function reply(id: number, value: Reply): void {
        if (!started.connected) return;
        try {
          started.send({ kind: 'reply', id, value });
        } catch {
          // Канал закрылся: программа уже завершилась — отвечать некому.
        }
      }

      started.on('close', (code) => {
        // Процесс закрылся, но итога не прислал: значит упал сам (например, его
        // убило ядром памяти) или был убит по времени.
        if (settled) return;
        const reason = timedOut
          ? `программа не уложилась в ${Math.round(timeoutMs / 1000)} с и была остановлена`
          : `программа завершилась без ответа (код ${code ?? 'нет'})`;
        finish({
          logs: '',
          calls,
          ms: Date.now() - startedAt,
          timedOut,
          truncated: false,
          error: reason,
          ...(stderr.trim() ? { stack: stderr.trim().split('\n').slice(0, 6).join('\n') } : {}),
          ...agentFields(),
          ...(callsExceeded ? { callsExceeded: true } : {}),
        });
      });

      started.on('error', (error) => {
        finish({
          logs: '',
          calls,
          ms: Date.now() - startedAt,
          timedOut: false,
          truncated: false,
          error: `программу не удалось запустить: ${error.message}`,
          ...agentFields(),
        });
      });
    }).finally(async () => {
      child?.removeAllListeners();
      await cleanup();
    });
  } catch (error) {
    await cleanup();
    return failed(`программу не удалось запустить: ${describe(error)}`, Date.now() - startedAt);
  }
}

/** Пути для модели прав: реальные, потому что `/var` на macOS — симлинк. */
async function allowedPaths(root: string, dir: string): Promise<{ root: string; read: string[]; write: string[] }> {
  const realRoot = await fs.realpath(root).catch(() => root);
  const realDir = await fs.realpath(dir).catch(() => dir);
  return {
    root: realRoot,
    // Читать — проект и папку запуска (там лежит сама программа и обвязка).
    read: [realDir, realRoot],
    // Писать — только папку запуска: правки проекта идут через инструменты,
    // где есть ревью и отмена.
    write: [realDir],
  };
}

/** Строки вывода под потолок: сначала обрезаем по символам, потом по строкам. */
function joinLogs(lines: readonly string[], limit: number): { text: string; truncated: boolean } {
  const joined = lines.join('\n');
  const clamped = clampProgramText(joined, limit);
  return clamped;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}

/** Итог без запуска: причина уже известна. */
function failed(reason: string, ms = 0): RunCodeOutcome {
  return { logs: '', calls: [], ms, timedOut: false, truncated: false, error: reason };
}
