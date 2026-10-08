import { app } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as pty from 'node-pty';
import {
  PushTopic,
  RpcErrorCode,
  type TerminalCreateOptions,
  type TerminalSession,
} from '../../shared/api';
import { RpcFailure } from '../ipc/router';

/** Вывод pty приходит мелкими порциями: склеиваем их, чтобы не топить IPC. */
const FLUSH_INTERVAL_MS = 8;
const MAX_SESSIONS = 8;

interface Session {
  readonly id: string;
  readonly title: string;
  readonly shell: string;
  readonly cwd: string;
  readonly process: pty.IPty;
  pending: string;
  flushTimer: NodeJS.Timeout | null;
}

/**
 * Настоящий терминал: pty в main-процессе (node-pty), отрисовка — xterm.js в renderer.
 *
 * Через PTY работают полноэкранные программы и цвета; через обычные пайпы — нет.
 * Плата — нативный модуль, который нужно пересобирать под ABI Electron
 * (npm run rebuild), потому что бинарник, собранный для Node, в Electron падает.
 */
export class TerminalService {
  private readonly sessions = new Map<string, Session>();
  private sequence = 0;

  constructor(private readonly emit: (topic: string, payload: unknown) => void) {}

  list(): TerminalSession[] {
    return [...this.sessions.values()].map((session) => describe(session));
  }

  create(options: TerminalCreateOptions): TerminalSession {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, `Больше ${MAX_SESSIONS} терминалов открывать не нужно`);
    }

    const shell =
      process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
    const cwd = options.cwd && existsSync(options.cwd) ? options.cwd : app.getPath('home');

    this.sequence += 1;
    const id = `term-${this.sequence}`;
    const title = this.uniqueTitle(path.basename(shell));

    let child: pty.IPty;
    try {
      child = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: Math.max(options.cols, 2),
        rows: Math.max(options.rows, 2),
        cwd,
        env: terminalEnv(),
      });
    } catch (error) {
      throw new RpcFailure(
        RpcErrorCode.Internal,
        `Не удалось запустить ${shell}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const session: Session = {
      id,
      title,
      shell,
      cwd,
      process: child,
      pending: '',
      flushTimer: null,
    };
    this.sessions.set(id, session);

    child.onData((data) => this.buffer(session, data));
    child.onExit(({ exitCode, signal }) => {
      this.flush(session);
      this.sessions.delete(id);
      this.emit(PushTopic.TerminalExit, { id, exitCode, signal });
    });

    return describe(session);
  }

  write(id: string, data: string): void {
    this.require(id).process.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.require(id);
    try {
      session.process.resize(Math.max(cols, 2), Math.max(rows, 2));
    } catch {
      // процесс уже завершился — размер ему не важен
    }
  }

  kill(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    try {
      session.process.kill();
    } catch {
      // уже не живой
    }
    this.emit(PushTopic.TerminalExit, { id, exitCode: 0 });
  }

  /** Вызывается при выходе из приложения: не оставляем висящие shell-процессы. */
  dispose(): void {
    for (const session of [...this.sessions.values()]) {
      if (session.flushTimer) clearTimeout(session.flushTimer);
      try {
        session.process.kill();
      } catch {
        // ignore
      }
    }
    this.sessions.clear();
  }

  private require(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new RpcFailure(RpcErrorCode.NotFound, `Терминал не найден: ${id}`);
    return session;
  }

  private buffer(session: Session, data: string): void {
    session.pending += data;
    if (session.flushTimer) return;
    session.flushTimer = setTimeout(() => {
      session.flushTimer = null;
      this.flush(session);
    }, FLUSH_INTERVAL_MS);
  }

  private flush(session: Session): void {
    if (!session.pending) return;
    const data = session.pending;
    session.pending = '';
    this.emit(PushTopic.TerminalData, { id: session.id, data });
  }

  private uniqueTitle(base: string): string {
    const used = new Set([...this.sessions.values()].map((session) => session.title));
    if (!used.has(base)) return base;
    let index = 2;
    while (used.has(`${base} (${index})`)) index += 1;
    return `${base} (${index})`;
  }
}

function describe(session: Session): TerminalSession {
  return {
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    shell: session.shell,
    pid: session.process.pid,
  };
}

function terminalEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
