import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sandboxDockerArgs, SANDBOX_ENGINES, type AiSandboxSettings } from '../../shared/sandbox';
import { runProcess, type CommandResult } from '../ai/run-command';

/**
 * Песочница: команды агента идут в контейнер, а не на машину пользователя.
 *
 * Запускает `docker run` (или `podman` — у него тот же CLI) с единственным
 * монтированием: корень проекта. Ни домашнего каталога, ни сокета docker, ни
 * переменных окружения хоста контейнер не видит — иначе изоляция была бы на
 * словах. Сборка аргументов живёт в `shared/sandbox.ts` и проверяется тестами:
 * там же объяснено, почему команда не может «вылезти» из своей позиции.
 *
 * Отдельное правило, важнее остальных: если песочница включена, а движка нет,
 * команда НЕ выполняется на хосте. Тихий откат дал бы ложное чувство
 * безопасности — человек считал бы, что запускает чужой код в изоляции, а тот
 * шёл бы на его машине.
 */

/** Что умеет песочница для инструментов агента. */
export interface SandboxRunner {
  /** Подпись для вывода: где именно шла команда. */
  readonly label: string;
  /** Можно ли выполнить команду: движок найден. */
  readonly available: boolean;
  run(command: string, cwd: string, signal?: AbortSignal): Promise<CommandResult>;
}

/** Путь к движку контейнеров в PATH. Ищем и `docker`, и `podman`. */
export function findSandboxEngine(): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const name of SANDBOX_ENGINES) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export class SandboxService implements SandboxRunner {
  private readonly engine: string | null;

  /**
   * `engine` передаётся только проверками: в работе движок ищется по PATH.
   * `undefined` — искать самому, `null` — считать, что движка нет.
   */
  constructor(
    private readonly config: () => AiSandboxSettings,
    engine?: string | null,
  ) {
    this.engine = engine === undefined ? findSandboxEngine() : engine;
  }

  get available(): boolean {
    return this.engine !== null;
  }

  get label(): string {
    return `контейнер ${this.config().image.trim()}`;
  }

  async run(command: string, cwd: string, signal?: AbortSignal): Promise<CommandResult> {
    if (!this.engine) {
      throw new Error(
        'Песочница включена, но движок контейнеров не найден. Установите docker или podman ' +
          'либо выключите песочницу в настройках — на хост команды не переключаются.',
      );
    }

    // Владелец файлов внутри контейнера — тот же пользователь, что и снаружи:
    // иначе созданные в проекте файлы остались бы root-овыми. На других
    // платформах этим занят Docker Desktop, а uid там ничего не значит.
    const user = process.platform === 'linux' ? hostUser() : '';
    const args = sandboxDockerArgs(this.config(), command, {
      root: cwd,
      ...(user ? { user } : {}),
    });

    // Каталог запуска самого `docker` — домашний: если проекта уже нет на месте,
    // ошибка должна быть про контейнер, а не про cwd.
    return runProcess(this.engine, args, os.homedir(), signal);
  }
}

/** `uid:gid` пользователя хоста: тот же владелец у файлов в смонтированном проекте. */
function hostUser(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
  if (uid === undefined || gid === undefined) return '';
  return `${uid}:${gid}`;
}
