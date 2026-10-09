import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  PushTopic,
  type DebugBreakpoint,
  type DebugFrame,
  type DebugLaunchOptions,
  type DebugScope,
  type DebugVariable,
  type DebugPhase,
  type DebugStatePayload,
} from '../../shared/api';
import { mergeEnv } from '../project-env';

/**
 * Отладчик Python: сессия `debugpy` по протоколу DAP.
 *
 * Живёт в main, потому что отладчик — внешний процесс, а renderer к процессам
 * доступа не имеет. Здесь только транспорт и состояние: запускаем адаптер
 * (`python -m debugpy.adapter`), шлём ему запросы DAP и превращаем события в
 * push-уведомления, которые рисует интерфейс (точки останова, стек, переменные).
 *
 * Почему адаптер, а не `debugpy --listen`: адаптер говорит по stdio, и его не
 * нужно связывать по порту — соединение не оборвётся и порт не займётся. Тот же
 * путь использует расширение Python для VS Code.
 */

/** Запросы DAP без ответа внятной ошибки не дадут: не ждём дольше этого. */
const REQUEST_TIMEOUT_MS = 15_000;

interface DapMessage {
  seq?: number;
  type: 'request' | 'response' | 'event';
  command?: string;
  event?: string;
  request_seq?: number;
  success?: boolean;
  message?: string;
  body?: unknown;
  arguments?: unknown;
}

/** Ожидание ответа на запрос: `seq` — наш идентификатор. */
interface Pending {
  resolve: (message: DapMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class DebugService {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = Buffer.alloc(0);
  private nextSeq = 1;
  private readonly pending = new Map<number, Pending>();

  private phase: DebugPhase = 'idle';
  /** Точки останова по файлам: путь → строки. Набор шлём целиком, как велит DAP. */
  private readonly breakpoints = new Map<string, DebugBreakpointInput[]>();
  /** Кадры текущего останова — по ним строится стек и запрашиваются переменные. */
  private frames: DebugFrame[] = [];
  /** Кадр, где стоит курсор: у него берём переменные по умолчанию. */
  private topFrameId: number | null = null;

  constructor(
    private readonly publish: (topic: string, payload: unknown) => void,
    private readonly root: () => string | null,
    /** Интерпретатор проекта: тем же питоном, что запуск и тесты. */
    private readonly pythonPath: () => string | null,
    private readonly env: () => Promise<Record<string, string>> = async () => ({}),
    /**
     * Чем запускать адаптер. По умолчанию — `python -m debugpy.adapter`; шов нужен,
     * чтобы подменить адаптер в тестах (фейковый DAP-сервер) и не тащить debugpy.
     */
    private readonly adapter?: () => { command: string; args: string[] },
  ) {}

  /** Текущая фаза: интерфейс спрашивает её при открытии панели. */
  status(): { phase: DebugPhase } {
    return { phase: this.phase };
  }

  /* ── сессия ────────────────────────────────────────────────────────────── */

  /** Начать отладку файла. Прошлую сессию закрываем: двух быть не должно. */
  async start(program: string, options: DebugLaunchOptions = {}): Promise<{ ok: boolean; message: string }> {
    const python = this.pythonPath() ?? (process.platform === 'win32' ? 'python' : 'python3');
    this.stop();

    const workingDir = options.cwd ?? this.root() ?? undefined;
    const env = mergeEnv(process.env, await this.env());

    const spec = this.adapter ? this.adapter() : { command: python, args: ['-m', 'debugpy.adapter'] };
    this.setPhase('starting');
    try {
      this.child = spawn(spec.command, spec.args, {
        cwd: workingDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      this.setPhase('idle');
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }

    this.child.stdout.on('data', (chunk: Buffer) => this.feed(chunk));
    // stderr адаптера — это его собственные жалобы: показываем как вывод отладчика.
    this.child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (text.trim()) this.publish(PushTopic.DebugOutput, { category: 'stderr', text });
    });
    this.child.on('exit', () => this.ended());

    try {
      await this.call('initialize', {
        adapterID: 'python',
        clientID: 'chui',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
      });
    } catch (error) {
      this.stop();
      return { ok: false, message: `Не удалось запустить debugpy: ${error instanceof Error ? error.message : String(error)}` };
    }

    // `launch` отвечает только после configurationDone — ждать его здесь нельзя,
    // иначе отправка точек останова не случится. Шлём и идём дальше.
    void this.call('launch', {
      program,
      cwd: workingDir,
      // Аргументы программы — стандартное поле DAP `args`. Пустой список не шлём:
      // отсутствие поля и пустой массив отладчик понимает одинаково, но лишний
      // параметр в запросе — шум в логе.
      ...(options.args && options.args.length > 0 ? { args: options.args } : {}),
      // Переменные окружения программы (`env` в DAP) — только для отлаживаемого
      // процесса: адаптер и так наследует окружение проекта, а эти значения поверх.
      ...(options.env && Object.keys(options.env).length > 0 ? { env: options.env } : {}),
      console: 'internalConsole',
      redirectOutput: true,
    }).catch((error) => this.publish(PushTopic.DebugOutput, { category: 'stderr', text: `launch: ${error.message}` }));

    return { ok: true, message: 'Отладка запущена' };
  }

  stop(): void {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    // Мягко просим отключиться; если не успел — процесс всё равно снимем ниже.
    this.call('disconnect', { terminateDebuggee: true }, 1500).catch(() => undefined);
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        // уже мёртв
      }
    }, 300);
    this.clearSession('Сессия отладки остановлена');
  }

  dispose(): void {
    this.stop();
  }

  /* ── точки останова и управление ───────────────────────────────────────── */

  /**
   * Задать точки останова файла. Отладчик ещё не запущен — просто запоминаем и
   * отдадим их при старте. Запущен — шлём сразу и возвращаем, что он подтвердил.
   *
   * Набор заменяется целиком, как велит DAP: отладчик не умеет «добавь одну» —
   * он сверяет присланное со своим состоянием и гасит лишнее.
   */
  async setBreakpoints(path: string, breakpoints: readonly DebugBreakpointInput[]): Promise<DebugBreakpoint[]> {
    const wanted = normalizeBreakpoints(breakpoints);
    if (wanted.length === 0) this.breakpoints.delete(path);
    else this.breakpoints.set(path, wanted);

    if (!this.child) return wanted.map((item) => ({ ...item, verified: false }));

    const response = await this.call('setBreakpoints', {
      source: { path },
      // Настройки точки (`condition`, `hitCondition`, `logMessage`) — стандартные
      // поля DAP, debugpy их понимает. Не заданные не шлём: пустое поле может
      // значить не то же самое, что отсутствие поля.
      breakpoints: wanted.map((item) => ({
        line: item.line,
        ...(item.condition ? { condition: item.condition } : {}),
        ...(item.hitCondition ? { hitCondition: item.hitCondition } : {}),
        ...(item.logMessage ? { logMessage: item.logMessage } : {}),
      })),
    }).catch(() => null);
    const verified =
      (response?.body as { breakpoints?: Array<{ line?: number; verified?: boolean }> } | undefined)?.breakpoints ?? [];
    // Отладчик может сдвинуть строку (пустая строка, закрывающая скобка) — берём его
    // ответ. Наши настройки он не возвращает, поэтому переносим их сами.
    return verified.map((item, index) => ({
      ...(wanted[index] ?? { line: 0 }),
      line: item.line ?? wanted[index]?.line ?? 0,
      verified: item.verified === true,
    }));
  }

  async resume(): Promise<void> {
    const threadId = this.threadId;
    if (threadId === null) return;
    this.setPhase('running');
    await this.call('continue', { threadId }).catch(() => undefined);
  }

  async step(kind: 'over' | 'into' | 'out'): Promise<void> {
    const threadId = this.threadId;
    if (threadId === null) return;
    const command = kind === 'over' ? 'next' : kind === 'into' ? 'stepIn' : 'stepOut';
    this.setPhase('running');
    await this.call(command, { threadId }).catch(() => undefined);
  }

  async pause(): Promise<void> {
    const threadId = this.threadId;
    if (threadId === null) return;
    await this.call('pause', { threadId }).catch(() => undefined);
  }

  async scopes(frameId: number): Promise<DebugScope[]> {
    const response = await this.call('scopes', { frameId }).catch(() => null);
    const scopes = (response?.body as { scopes?: Array<{ name?: string; variablesReference?: number; expensive?: boolean }> } | undefined)?.scopes ?? [];
    return scopes.map((scope) => ({
      name: scope.name ?? 'значения',
      variablesReference: scope.variablesReference ?? 0,
      expensive: scope.expensive === true,
    }));
  }

  async variables(reference: number): Promise<DebugVariable[]> {
    const response = await this.call('variables', { variablesReference: reference }).catch(() => null);
    const variables = (response?.body as { variables?: Array<{ name?: string; value?: string; type?: string; variablesReference?: number }> } | undefined)?.variables ?? [];
    return variables.map((variable) => ({
      name: variable.name ?? '',
      value: variable.value ?? '',
      type: variable.type ?? null,
      variablesReference: variable.variablesReference ?? 0,
    }));
  }

  /**
   * Вычислить выражение в контексте кадра — панель «наблюдение».
   *
   * Ошибку выражения отдаём как значение, а не как сбой запроса: неверное имя
   * переменной при остановке — обычное дело, и человеку нужен текст ошибки там
   * же, где он ждал значение, а не тост.
   */
  async evaluate(expression: string, frameId?: number): Promise<DebugVariable> {
    const text = expression.trim();
    if (!text) return { name: text, value: '', type: null, variablesReference: 0 };

    const threadId = this.thread;
    const frame = frameId ?? this.topFrameId ?? this.frames[0]?.id ?? null;
    if (threadId === null || frame === null) {
      return { name: text, value: 'нет остановленной программы', type: null, variablesReference: 0 };
    }

    // Сообщение ошибки берём из ответа адаптера как есть: «name 'x' is not defined»
    // объясняет причину, а «отладчик не ответил» — нет. Поэтому ошибку запроса не
    // глотаем, а превращаем в значение.
    try {
      const response = await this.call('evaluate', { expression: text, frameId: frame, context: 'watch' });
      const body = response.body as { result?: unknown; type?: unknown; variablesReference?: unknown } | undefined;
      return {
        name: text,
        value: typeof body?.result === 'string' ? body.result : '',
        type: typeof body?.type === 'string' ? body.type : null,
        variablesReference: typeof body?.variablesReference === 'number' ? body.variablesReference : 0,
      };
    } catch (error) {
      return {
        name: text,
        value: error instanceof Error ? error.message : 'ошибка выражения',
        type: null,
        variablesReference: 0,
      };
    }
  }

  /**
   * Значение выражения для подсказки под курсором. Отличается от `evaluate` тем,
   * что ошибку НЕ показываем: навести мышь можно на что угодно, и подсказка
   * «name 'x' is not defined» под каждым служебным словом была бы шумом. Нет
   * значения — `null`, и подсказка просто не появится.
   */
  async hover(expression: string, frameId?: number): Promise<DebugVariable | null> {
    const text = expression.trim();
    if (!text) return null;

    const threadId = this.thread;
    const frame = frameId ?? this.topFrameId ?? this.frames[0]?.id ?? null;
    if (threadId === null || frame === null) return null;

    try {
      const response = await this.call('evaluate', { expression: text, frameId: frame, context: 'hover' });
      const body = response.body as { result?: unknown; type?: unknown; variablesReference?: unknown } | undefined;
      const value = typeof body?.result === 'string' ? body.result : '';
      if (!value) return null;
      return {
        name: text,
        value,
        type: typeof body?.type === 'string' ? body.type : null,
        variablesReference: typeof body?.variablesReference === 'number' ? body.variablesReference : 0,
      };
    } catch {
      // Ошибку выражения прячем: для подсказки это не значение, а отсутствие значения.
      return null;
    }
  }

  /**
   * Задать новое значение переменной или поля — правка прямо в панели отладки.
   *
   * DAP зовёт это `setVariable`: отладчик присваивает и возвращает фактическое
   * значение (оно может отличаться от введённого, если тип приводится). Ответ
   * отдаём в форме `DebugVariable`, чтобы панель обновила строку тем же типом,
   * что и при чтении. Ошибку (нельзя присвоить, имя неизвестно) — `null`.
   */
  async setVariable(reference: number, name: string, value: string): Promise<DebugVariable | null> {
    const text = name.trim();
    if (!text) return null;
    const response = await this
      .call('setVariable', { variablesReference: reference, name: text, value })
      .catch(() => null);
    if (!response) return null;
    const body = response.body as { value?: unknown; type?: unknown; variablesReference?: unknown } | undefined;
    return {
      name: text,
      value: typeof body?.value === 'string' ? body.value : value,
      type: typeof body?.type === 'string' ? body.type : null,
      variablesReference: typeof body?.variablesReference === 'number' ? body.variablesReference : 0,
    };
  }

  /**
   * Задать значение произвольному выражению в кадре (`setExpression` в DAP).
   * Отличие от `setVariable`: там имя берётся из контейнера, а здесь выражение
   * задаёт сам человек — так правят элемент списка (`items[0]`) или поле объекта
   * (`config.debug`), которым в дереве переменных не соответствовала строка.
   * Ответ отладчика возвращаем как значение; не удалось — `null`.
   */
  async setExpression(expression: string, value: string, frameId?: number): Promise<DebugVariable | null> {
    const text = expression.trim();
    if (!text) return null;
    const frame = frameId ?? this.topFrameId ?? this.frames[0]?.id ?? null;
    if (this.thread === null || frame === null) return null;

    const response = await this
      .call('setExpression', { expression: text, value, frameId: frame })
      .catch(() => null);
    if (!response) return null;
    const body = response.body as { value?: unknown; type?: unknown; variablesReference?: unknown } | undefined;
    return {
      name: text,
      value: typeof body?.value === 'string' ? body.value : value,
      type: typeof body?.type === 'string' ? body.type : null,
      variablesReference: typeof body?.variablesReference === 'number' ? body.variablesReference : 0,
    };
  }

  /** Кадры текущего останова: панель берёт их отсюда, не запрашивая заново. */
  stack(): DebugFrame[] {
    return this.frames;
  }

  /* ── транспорт DAP ─────────────────────────────────────────────────────── */

  private get threadId(): number | null {
    return this.thread;
  }
  /** Идентификатор потока, где произошёл останов: у Python он один. */
  private thread: number | null = null;

  /** Запрос к адаптеру; ошибка или тайм-аут — исключение. */
  private call(command: string, args: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<DapMessage> {
    const child = this.child;
    if (!child) return Promise.reject(new Error('Сессия отладки не запущена'));

    const seq = this.nextSeq;
    this.nextSeq += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`Отладчик не ответил на ${command}`));
      }, timeoutMs);
      this.pending.set(seq, { resolve, reject, timer });
      this.send({ seq, type: 'request', command, arguments: args });
      void child;
    });
  }

  private send(message: DapMessage): void {
    const child = this.child;
    if (!child) return;
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  }

  /** Разбор потока: заголовок `Content-Length: N` и тело из N байт. */
  private feed(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.slice(0, headerEnd).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      const start = headerEnd + 4;
      if (!match) {
        this.buffer = this.buffer.slice(start);
        continue;
      }
      const length = Number(match[1]);
      if (this.buffer.length < start + length) return;
      const body = this.buffer.slice(start, start + length).toString('utf8');
      this.buffer = this.buffer.slice(start + length);
      try {
        this.dispatch(JSON.parse(body) as DapMessage);
      } catch {
        // обрывок кадра — пропускаем
      }
    }
  }

  private dispatch(message: DapMessage): void {
    if (message.type === 'response') {
      const seq = message.request_seq;
      if (seq === undefined) return;
      const pending = this.pending.get(seq);
      if (!pending) return;
      this.pending.delete(seq);
      clearTimeout(pending.timer);
      if (message.success === false) pending.reject(new Error(message.message ?? 'Запрос DAP завершился ошибкой'));
      else pending.resolve(message);
      return;
    }
    if (message.type === 'event') this.onEvent(message);
  }

  /* ── события адаптера ──────────────────────────────────────────────────── */

  private onEvent(message: DapMessage): void {
    const body = (message.body ?? {}) as Record<string, unknown>;
    switch (message.event) {
      case 'initialized':
        // Разрешено слать точки останова; после них — configurationDone, иначе
        // программа не начнёт выполняться.
        void this.pushAllBreakpoints();
        break;
      case 'process':
        // Программа пошла. Без этого фаза оставалась «starting» до первого
        // останова, а значит в панели были недоступны «Пауза» и «Стоп».
        if (body.startMethod !== 'attach' || this.phase === 'starting') this.setPhase('running');
        break;
      case 'thread': {
        // Отладчик объявляет потоки заранее, ещё до первого останова. Без этого
        // «Пауза» на идущей программе не работала бы: она шлёт threadId, а взять
        // его было негде — останов ещё не случался.
        const threadId = typeof body.threadId === 'number' ? body.threadId : null;
        if (body.reason === 'started') {
          if (this.thread === null) this.thread = threadId;
        } else if (threadId !== null && threadId === this.thread) {
          this.thread = null; // поток, который мы запомнили, завершился
        }
        break;
      }
      case 'stopped':
        this.thread = typeof body.threadId === 'number' ? body.threadId : this.thread;
        void this.onStopped(typeof body.reason === 'string' ? body.reason : 'stopped');
        break;
      case 'continued':
        // Поток запоминаем: одиночный Python-поток тот же, поэтому «Пауза»
        // и шаги после продолжения должны знать его threadId.
        this.thread = typeof body.threadId === 'number' ? body.threadId : this.thread;
        this.frames = [];
        this.topFrameId = null;
        this.setPhase('running');
        break;
      case 'output':
        this.publish(PushTopic.DebugOutput, {
          category: typeof body.category === 'string' ? body.category : 'stdout',
          text: typeof body.output === 'string' ? body.output : '',
        });
        break;
      case 'terminated':
      case 'exited':
        this.ended();
        break;
      default:
        break;
    }
  }

  /** Отправить все известные точки останова и разрешить старт программы. */
  private async pushAllBreakpoints(): Promise<void> {
    for (const [path, lines] of this.breakpoints) {
      await this.setBreakpoints(path, lines).catch(() => undefined);
    }
    await this.call('configurationDone', {}).catch(() => undefined);
  }

  private async onStopped(reason: string): Promise<void> {
    const frames = await this.fetchStack();
    this.frames = frames;
    this.topFrameId = frames[0]?.id ?? null;
    this.setPhase('stopped', reason);
    this.publish(PushTopic.DebugStopped, { reason, frames });
  }

  private async fetchStack(): Promise<DebugFrame[]> {
    const threadId = this.thread;
    if (threadId === null) return [];
    const response = await this.call('stackTrace', { threadId }).catch(() => null);
    const raw = (response?.body as { stackFrames?: Array<Record<string, unknown>> } | undefined)?.stackFrames ?? [];
    return raw.map((frame) => ({
      id: typeof frame.id === 'number' ? frame.id : 0,
      name: typeof frame.name === 'string' ? frame.name : '',
      path: typeof (frame.source as { path?: unknown } | undefined)?.path === 'string' ? ((frame.source as { path: string }).path) : null,
      line: typeof frame.line === 'number' ? frame.line : 1,
      column: typeof frame.column === 'number' ? frame.column : 1,
    }));
  }

  /** Сессия завершилась: чистим и говорим интерфейсу, что отладка кончилась. */
  private ended(): void {
    if (this.phase === 'idle' && !this.child) return;
    this.child = null;
    this.clearSession('Отладка завершена');
  }

  /**
   * Общий сброс состояния сессии — один на оба выхода (явный стоп и завершение
   * процесса отладчика). Забытый здесь `thread` — не мелочь: с ним «Пауза» и
   * вычисление выражений уходят к мёртвому соединению, а новый поток из
   * следующей сессии не запоминается, потому что поле занято старым.
   */
  private clearSession(reason: string): void {
    this.rejectAll(new Error(reason));
    this.frames = [];
    this.topFrameId = null;
    this.thread = null;
    this.setPhase('idle');
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private setPhase(phase: DebugPhase, reason: string | null = null): void {
    this.phase = phase;
    const topFrame = this.frames.find((frame) => frame.id === this.topFrameId) ?? this.frames[0] ?? null;
    const payload: DebugStatePayload = { phase, reason, topFrame: phase === 'stopped' ? topFrame : null };
    this.publish(PushTopic.DebugState, payload);
  }
}

/** Точка останова в том виде, в каком её присылает renderer. */
export interface DebugBreakpointInput {
  line: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

/**
 * Привести точки к виду для DAP: только целые положительные строки, по одной на
 * строку, по возрастанию. Строковые настройки обрезаем — человек мог оставить
 * хвостовые пробелы, а пустое значение означает «настройки нет», а не «пустая».
 */
function normalizeBreakpoints(breakpoints: readonly DebugBreakpointInput[]): DebugBreakpointInput[] {
  const byLine = new Map<number, DebugBreakpointInput>();
  for (const item of breakpoints) {
    if (!Number.isInteger(item.line) || item.line < 1) continue;
    const condition = item.condition?.trim();
    const hitCondition = item.hitCondition?.trim();
    // Сообщение не обрезаем по краям: пробелы в нём — часть форматирования.
    const logMessage = item.logMessage?.length ? item.logMessage : undefined;
    byLine.set(item.line, {
      line: item.line,
      ...(condition ? { condition } : {}),
      ...(hitCondition ? { hitCondition } : {}),
      ...(logMessage ? { logMessage } : {}),
    });
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}
