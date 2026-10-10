import { app } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as pty from 'node-pty';
import { PushTopic, RpcErrorCode, type TerminalCreateOptions, type TerminalSession } from '../../shared/api';
import { RpcFailure } from '../ipc/router';
import { mergeEnv } from '../project-env';

/** Вывод pty приходит мелкими порциями: склеиваем их, чтобы не топить IPC. */
const FLUSH_INTERVAL_MS = 8;
const MAX_SESSIONS = 8;
/** Сколько держим вывод сессии: агент читает его с офсетом, буфер не растёт безлимитно. */
const SCROLLBACK_CHARS = 60_000;
/** Завершённую сессию держим ещё немного: агент должен успеть вычитать последний вывод. */
const EXIT_KEEP_MS = 60_000;

interface Session {
  readonly id: string;
  readonly title: string;
  readonly shell: string;
  readonly cwd: string;
  readonly process: pty.IPty;
  pending: string;
  flushTimer: NodeJS.Timeout | null;
  /** Накопленный вывод сессии: буфер, из которого читает агент. */
  log: string;
  /** Сколько символов выброшено из начала `log`: смещение остаётся абсолютным. */
  dropped: number;
  exited: boolean;
  exitCode?: number;
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

  constructor(
    private readonly emit: (topic: string, payload: unknown) => void,
    /**
     * Команда активации окружения проекта. Терминал набирает её сам, чтобы venv
     * был активен с первой строки: тогда pip, запуск и тесты видят одни пакеты.
     * Возвращает null — активировать нечего, сессия остаётся системной.
     */
    private readonly activateFor?: (cwd: string) => Promise<string | null>,
    /**
     * Переменные окружения проекта из `.env`. Терминал запускается с ними: серверы
     * разработки читают оттуда строки подключения и токены, и заставлять человека
     * повторять `export` в каждой сессии незачем.
     */
    private readonly env: () => Promise<Record<string, string>> = async () => ({}),
  ) {}

  list(): TerminalSession[] {
    return [...this.sessions.values()].filter((session) => !session.exited).map((session) => describe(session));
  }

  /**
   * Прочитать вывод сессии, начиная с абсолютного смещения `from`.
   * Смещение возвращается вместе с данными: следующий вызов передаёт его как `from`,
   * поэтому агент видит только НОВЫЙ вывод, а не всё заново.
   */
  read(id: string, from = 0): { data: string; offset: number; alive: boolean; exitCode?: number } {
    const session = this.require(id);
    const total = session.dropped + session.log.length;
    const start = Math.max(from, session.dropped);
    const data = start >= total ? '' : session.log.slice(start - session.dropped);
    return { data, offset: total, alive: !session.exited, exitCode: session.exitCode };
  }

  async create(options: TerminalCreateOptions): Promise<TerminalSession> {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, `Больше ${MAX_SESSIONS} терминалов открывать не нужно`);
    }

    const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
    const cwd = options.cwd && existsSync(options.cwd) ? options.cwd : app.getPath('home');

    this.sequence += 1;
    const id = `term-${this.sequence}`;
    const title = this.uniqueTitle(path.basename(shell));
    // `.env` проекта — поверх системного окружения: сессия видит те же значения,
    // что установка пакетов, тесты и языковой сервер.
    const env = mergeEnv(terminalEnv(), await this.env());

    let child: pty.IPty;
    try {
      child = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: Math.max(options.cols, 2),
        rows: Math.max(options.rows, 2),
        cwd,
        env,
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
      log: '',
      dropped: 0,
      exited: false,
    };
    this.sessions.set(id, session);

    // Окружение активируем не сразу: shell должен напечатать приглашение,
    // иначе команда попадёт в ещё не готовый pty и потеряется.
    void this.activateVenv(session);

    child.onData((data) => this.buffer(session, data));
    child.onExit(({ exitCode, signal }) => {
      this.flush(session);
      // Сессию не удаляем сразу: агенту нужно успеть вычитать финальный вывод.
      session.exited = true;
      session.exitCode = exitCode;
      this.emit(PushTopic.TerminalExit, { id, exitCode, signal });
      setTimeout(() => this.sessions.delete(id), EXIT_KEEP_MS).unref?.();
    });

    return describe(session);
  }

  write(id: string, data: string): void {
    this.require(id).process.write(data);
  }

  /**
   * Набрать в сессии команду активации окружения. Пишем сразу: pty буферизует
   * ввод до готовности shell, поэтому команда не потеряется и уйдёт раньше
   * любой команды запуска — venv окажется активен к её приходу.
   */
  private async activateVenv(session: Session): Promise<void> {
    if (!this.activateFor) return;
    try {
      const command = await this.activateFor(session.cwd);
      if (!command || session.exited) return;
      session.process.write(`${command}\r`);
    } catch {
      // окружения нет или не нашли — терминал просто остаётся системным
    }
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
    if (session.exited) {
      this.sessions.delete(id);
      return;
    }
    try {
      session.process.kill();
    } catch {
      // уже не живой
    }
    // Удаление сделает `onExit` — там же сохранится код выхода.
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
    this.appendLog(session, data);
    this.emit(PushTopic.TerminalData, { id: session.id, data });
  }

  /** Вывод копится в буфер сессии: его читает агент, и он же переживёт завершение процесса. */
  private appendLog(session: Session, data: string): void {
    session.log += data;
    if (session.log.length <= SCROLLBACK_CHARS) return;
    const cut = session.log.length - SCROLLBACK_CHARS;
    session.dropped += cut;
    session.log = session.log.slice(cut);
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
