import { spawn } from 'node:child_process';
import { createSpillStream } from './spill';

/**
 * Долгие команды как задания.
 *
 * Команда держит шаг, пока не закончится: для `echo` это
 * мгновение, а для сборки или `npm install` — минуты, в которые агент ничего не
 * делает и не может даже сказать, что там происходит. Ограничение времени тут не
 * выход: обрубленная на пределе сборка — это потерянная работа, а не ответ.
 *
 * Поэтому у команды, которая не кончается быстро, есть второй путь: она уходит в
 * фон, а на руках остаётся номер задания. По нему видно состояние (идёт, готово,
 * упало, с каким кодом), можно дочитать вывод с того места, где остановился, и
 * остановить, если стало ясно, что это не то.
 *
 * Здесь же и потолки, без которых затея вредна: заданий не больше десятка (иначе
 * они копятся молча), вывод держим хвостом в памяти (полная копия — в файле,
 * если каталог для него задан), а задание без конца снимается по пределу времени.
 *
 * Модуль — про процессы, а не про инструменты: как его позвать, решает
 * `agent-tools.ts`. Поэтому проверяется он без Electron и без модели.
 */

/** Сколько заданий держим одновременно: больше — это уже не «пара сборок». */
export const MAX_JOBS = 10;
/**
 * Потолок вывода в памяти на задание. Вывод длиннее всё равно читают хвостом, а
 * полная копия ложится в файл (см. `spillDir`).
 */
export const MAX_JOB_OUTPUT_CHARS = 200_000;
/** Предел жизни задания: больше получаса агент всё равно не дождётся. */
export const JOB_TIMEOUT_MS = 30 * 60_000;

export type JobStatus = 'running' | 'stopping' | 'completed' | 'failed';

/** Что видно о задании: состояние и как далеко прочитан вывод. */
export interface JobSnapshot {
  id: string;
  command: string;
  status: JobStatus;
  /** Время запуска (мс от эпохи): по нему видно, сколько уже идёт. */
  startedAt: number;
  /** Код выхода: `null` — процесса нет или он убит сигналом. */
  code: number | null;
  /** Имя сигнала, если процесс убит (в том числе по пределу времени). */
  signal: NodeJS.Signals | null;
  /** Выполнение прервано пределом времени. */
  timedOut: boolean;
  /** Сколько символов вывода уже пришло — это же смещение для чтения. */
  total: number;
  /** Полная копия вывода в файле: есть, только если каталог для копий задан. */
  file?: string;
}

export interface JobReadResult {
  /** Новый вывод с запрошенного смещения. */
  data: string;
  /** Смещение, с которого читать в следующий раз. */
  offset: number;
  snapshot: JobSnapshot;
}

export interface JobStartOptions {
  command: string;
  /** Каталог проекта: там команда и выполняется. */
  cwd: string;
  /** Куда складывать полные копии вывода (см. `ai/spill.ts`). */
  spillDir?: string;
  /** Предел времени; по умолчанию `JOB_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Чем закончилось: нужно, чтобы сказать агенту в следующем ходе. */
  onSettled?(snapshot: JobSnapshot): void;
  /**
   * Чем запускать. По умолчанию — оболочка пользователя (как у команды в терминале).
   * Нужно проверкам: они запускают процесс напрямую, иначе пришлось бы писать
   * команды, одинаковые в `sh` и в `cmd`, а таких почти нет.
   */
  exec?: { file: string; args: string[] };
}

/** Задание: снимок состояния, чтение нового вывода, остановка. */
export interface JobHandle {
  snapshot(): JobSnapshot;
  read(from?: number): JobReadResult;
  stop(): void;
}

export interface JobRegistry {
  start(options: JobStartOptions): JobHandle;
  /** Задание по номеру; `null` — такого нет (или оно уже убрано). */
  get(id: string): JobHandle | null;
  /** Все живые и недавние задания: видно, что вообще запущено. */
  list(): JobSnapshot[];
}

/** Оболочка пользователя — как у `runShellCommand`: rc-файлы и пайпы работают. */
function shellCommand(): { file: string; args: string[] } {
  if (process.platform === 'win32') return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c'] };
  return { file: process.env.SHELL || '/bin/bash', args: ['-c'] };
}

/** Окружение как у обычного запуска: без цветов, без второй копии IDE. */
function jobEnv(): NodeJS.ProcessEnv {
  return { ...process.env, NO_COLOR: '1', TERM: 'dumb', ELECTRON_RUN_AS_NODE: undefined };
}

class Job implements JobHandle {
  private status: JobStatus = 'running';
  private code: number | null = null;
  private signal: NodeJS.Signals | null = null;
  private timedOut = false;
  /** Вывод: держим хвост, а смещения считаем по всему пришедшему. */
  private text = '';
  private total = 0;
  private readonly startedAt = Date.now();
  private readonly spill;
  private file: string | undefined;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    readonly id: string,
    private readonly command: string,
    private readonly child: ReturnType<typeof spawn>,
    options: JobStartOptions,
    private readonly onSettled?: (snapshot: JobSnapshot) => void,
  ) {
    this.spill = options.spillDir ? createSpillStream(options.spillDir, `job_${id}`) : null;

    const collect = (chunk: Buffer): void => this.collect(chunk.toString('utf8'));
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', () => this.settle(null, null));
    child.on('close', (code, signal) => this.settle(code, signal));

    const limit = Math.min(options.timeoutMs ?? JOB_TIMEOUT_MS, JOB_TIMEOUT_MS);
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.stop();
    }, limit);
  }

  private collect(piece: string): void {
    if (!piece) return;
    this.total += piece.length;
    this.text += piece;
    // Хвост в памяти: начало уже прочитано или не понадобится, а полная копия —
    // в файле.
    if (this.text.length > MAX_JOB_OUTPUT_CHARS) this.text = this.text.slice(-MAX_JOB_OUTPUT_CHARS);
    this.spill?.write(piece);
  }

  /** Сколько символов уже выброшено из памяти: смещения отдаём по всему выводу. */
  private get dropped(): number {
    return this.total - this.text.length;
  }

  private settle(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.status === 'completed' || this.status === 'failed') return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.code = code;
    this.signal = signal;
    // Код 0 — успех; всё остальное (включая убитый процесс) считаем неудачей, но
    // говорим об этом кодом и сигналом, а не догадкой.
    this.status = code === 0 ? 'completed' : 'failed';
    // Полную копию оставляем всегда: упавшая сборка интереснее удавшейся.
    this.file = this.spill?.close(true) ?? undefined;
    this.onSettled?.(this.snapshot());
  }

  snapshot(): JobSnapshot {
    return {
      id: this.id,
      command: this.command,
      status: this.status,
      startedAt: this.startedAt,
      code: this.code,
      signal: this.signal,
      timedOut: this.timedOut,
      total: this.total,
      ...(this.file ? { file: this.file } : {}),
    };
  }

  read(from = 0): JobReadResult {
    const start = Math.max(from, this.dropped);
    const data = start >= this.total ? '' : this.text.slice(start - this.dropped);
    return { data, offset: this.total, snapshot: this.snapshot() };
  }

  stop(): void {
    if (this.status !== 'running') return;
    this.status = 'stopping';
    try {
      // Группой: `npm run build` порождает детей, и убить одну оболочку мало.
      if (process.platform === 'win32') this.child.kill('SIGKILL');
      else if (this.child.pid !== undefined) process.kill(-this.child.pid, 'SIGKILL');
      else this.child.kill('SIGKILL');
    } catch {
      // процесс уже умер — это нормально
    }
  }
}

/**
 * Реестр заданий окна. Заданий не больше `MAX_JOBS`: при переполнении убираем
 * самое старое ЗАВЕРШЁННОЕ, а если все ещё идут — отказываем в новом, а не
 * выкидываем чужую работу.
 */
export function createJobRegistry(): JobRegistry {
  const jobs = new Map<string, Job>();
  let counter = 0;

  const makeId = (): string => {
    counter += 1;
    return `job-${counter}`;
  };

  const prune = (): void => {
    if (jobs.size < MAX_JOBS) return;
    for (const [id, job] of jobs) {
      if (job.snapshot().status === 'running' || job.snapshot().status === 'stopping') continue;
      jobs.delete(id);
      return;
    }
  };

  return {
    start(options) {
      prune();
      if (jobs.size >= MAX_JOBS) {
        throw new Error(
          `Заданий уже ${MAX_JOBS}: сначала дочитайте или остановите старые (terminal: action output, action cancel).`,
        );
      }
      const id = makeId();
      const exec = options.exec ?? shellCommand();
      // Команда идёт последним аргументом оболочки: у прямого запуска её нет.
      const argv = options.exec ? [...exec.args] : [...exec.args, options.command];
      const child = spawn(exec.file, argv, {
        cwd: options.cwd,
        env: jobEnv(),
        // Своя группа процессов: остановка снимает и детей.
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const job = new Job(id, options.command, child, options, options.onSettled);
      jobs.set(id, job);
      return job;
    },
    get(id) {
      return jobs.get(id) ?? null;
    },
    list() {
      return [...jobs.values()].map((job) => job.snapshot());
    },
  };
}
