import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import {
  PushTopic,
  type DebugAttachOptions,
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
 * Отладчик: сессия по протоколу DAP.
 *
 * Живёт в main, потому что отладчик — внешний процесс, а renderer к процессам
 * доступа не имеет. Здесь только транспорт и состояние: поднимаем адаптер
 * (`python -m debugpy.adapter` или наш `node-adapter-main.js`), шлём ему запросы
 * DAP и превращаем события в push-уведомления, которые рисует интерфейс (точки
 * останова, стек, переменные). Какой адаптер поднимать, решает отлаживаемая
 * сторона: `.js`/`.ts` — Node, всё остальное — Python.
 *
 * Почему адаптер, а не подключение к порту: адаптер говорит по stdio, и его не
 * нужно связывать по порту — соединение не оборвётся и порт не займётся. Тот же
 * путь использует расширение Python для VS Code. Исключение — `attach`: там
 * отлаживаемый процесс уже слушает свой порт, и адаптер подключается к нему.
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

/** Чем запускать отладочный адаптер: команда, аргументы, `adapterID` и довесок к окружению. */
interface AdapterSpec {
  command: string;
  args: string[];
  adapterID: string;
  env: Record<string, string>;
}

export class DebugService {
  private child: ChildProcessWithoutNullStreams | null = null;
  /**
   * Второй транспорт: TCP-сокет. Нужен там, где адаптер слушает порт сам, — это
   * подключение к Python-процессу, запущенному `debugpy --listen`: адаптер уже
   * поднят и говорит по DAP, поэтому подключаемся к нему клиентом, а не поднимаем
   * свой адаптер (тот ждал бы, пока цель подключится к нему). Живым бывает ровно
   * один из двух транспортов, `child` или `socket`.
   */
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private nextSeq = 1;
  private readonly pending = new Map<number, Pending>();

  /** Пришло ли `initialized` в текущей сессии: подключение рапортует успех не раньше него. */
  private initializedSeen = false;
  /** Кто ждёт `initialized`; получают `true`, когда событие придёт, иначе `false`. */
  private readonly initializedWaiters = new Set<(ok: boolean) => void>();

  private phase: DebugPhase = 'idle';
  /** Точки останова по файлам: путь → строки. Набор шлём целиком, как велит DAP. */
  private readonly breakpoints = new Map<string, DebugBreakpointInput[]>();
  /** Кадры текущего останова — по ним строится стек и запрашиваются переменные. */
  private frames: DebugFrame[] = [];
  /** Кадр, где стоит курсор: у него берём переменные по умолчанию. */
  private topFrameId: number | null = null;
  /** Останов по исключению: какие исключения останавливают программу. */
  private exceptions = { uncaught: false, caught: false };
  /** Фильтры задавал пользователь: без этого адаптер не трогаем — у него свой набор. */
  private exceptionsSet = false;
  /** Сторона отладки: от неё зависит имя фильтра у адаптера (`caught` против `raised`). */
  private target: 'node' | 'python' = 'node';

  constructor(
    private readonly publish: (topic: string, payload: unknown) => void,
    private readonly root: () => string | null,
    /** Интерпретатор проекта: тем же питоном, что запуск и тесты. */
    private readonly pythonPath: () => string | null,
    private readonly env: () => Promise<Record<string, string>> = async () => ({}),
    /**
     * Подмена адаптера — шов для тестов: там настоящий debugpy или Node-адаптер не
     * поднимают, а играют фейковый DAP-сервер. В бою адаптер выбирается по программе.
     */
    private readonly adapter?: () => Partial<AdapterSpec> & { command: string; args: string[] },
  ) {}

  /** Текущая фаза: интерфейс спрашивает её при открытии панели. */
  status(): { phase: DebugPhase } {
    return { phase: this.phase };
  }

  /**
   * Чем поднимать адаптер под эту программу.
   *
   * Python идёт через `debugpy.adapter`, JS — через наш адаптер
   * (`node-adapter-main.js`), который говорит с Node по CDP. Файл лежит рядом с
   * собранным `debug.js`, поэтому путь берём от `__dirname`. Шов `adapter`
   * (тесты) перекрывает выбор целиком.
   */
  private resolveAdapter(program: string): AdapterSpec {
    return this.adapterFor(isNodeProgram(program) ? 'node' : 'python');
  }

  /** Адаптер по отлаживаемой стороне: одна и та же и для запуска, и для подключения. */
  private adapterFor(target: 'node' | 'python'): AdapterSpec {
    const override = this.adapter?.();
    if (override) return { adapterID: 'python', env: {}, ...override };

    if (target === 'node') {
      return {
        // Тот же исполняемый файл, что у приложения: под `ELECTRON_RUN_AS_NODE` он
        // работает как обычный Node — так встроенный `WebSocket` гарантированно есть.
        command: process.execPath,
        args: [path.join(__dirname, 'node-adapter-main.js')],
        adapterID: 'node',
        env: { ELECTRON_RUN_AS_NODE: '1' },
      };
    }

    const python = this.pythonPath() ?? (process.platform === 'win32' ? 'python' : 'python3');
    return { command: python, args: ['-m', 'debugpy.adapter'], adapterID: 'python', env: {} };
  }

  /* ── сессия ────────────────────────────────────────────────────────────── */

  /** Начать отладку файла. Прошлую сессию закрываем: двух быть не должно. */
  async start(program: string, options: DebugLaunchOptions = {}): Promise<{ ok: boolean; message: string }> {
    return this.openAdapter(this.resolveAdapter(program), options.cwd ?? this.root() ?? undefined, 'launch', {
      program,
      // Рабочий каталог нужен и программе: в нём она запускается.
      cwd: options.cwd ?? this.root() ?? undefined,
      // Аргументы программы — стандартное поле DAP `args`. Пустой список не шлём:
      // отсутствие поля и пустой массив отладчик понимает одинаково, но лишний
      // параметр в запросе — шум в логе.
      ...(options.args && options.args.length > 0 ? { args: options.args } : {}),
      // Переменные окружения программы (`env` в DAP) — только для отлаживаемого
      // процесса: адаптер и так наследует окружение проекта, а эти значения поверх.
      ...(options.env && Object.keys(options.env).length > 0 ? { env: options.env } : {}),
      console: 'internalConsole',
      redirectOutput: true,
    }, 'Отладка запущена');
  }

  /**
   * Подключиться к уже запущенному процессу.
   *
   * Программу здесь не запускают: она уже работает, и перезапуск был бы не
   * отладкой, а подменой. Адаптеру сообщаем только, где искать её инспектор.
   * Форма запроса у Node и Python разная (`port` против `connect`), поэтому
   * собираем её по отлаживаемой стороне, а не отдаём клиенту.
   */
  async attach(options: DebugAttachOptions): Promise<{ ok: boolean; message: string }> {
    const target = options.target ?? 'node';
    const host = options.host?.trim() || '127.0.0.1';
    // Python: цель запущена `debugpy --listen`, и адаптер уже слушает её порт —
    // значит, подключаемся к нему сокетом (см. `openSocket`). Форма запроса на
    // подключение у него своя — поле `connect`; поле `port`/`host` сверху он
    // принимает не для этого и молча игнорирует, из-за чего раньше подключение
    // «проходило», но отладка не начиналась.
    if (target === 'python') return this.openSocket(host, options.port, { connect: { host, port: options.port } });
    // Node: инспектор адресуется портом, а адаптер наш — поднимаем его по stdio и
    // отдаём ему адрес инспектора. Успех подтверждает сам адаптер: событием
    // `initialized` (см. `waitInitialized`).
    return this.openAdapter(this.adapterFor('node'), this.root() ?? undefined, 'attach', { port: options.port, host }, 'Отладка подключена', true);
  }

  /**
   * Поднять адаптер и провести общую часть сессии: спавн, `initialize`, запрос
   * (`launch` или `attach`). Различие двух запросов — только в их полях, а всё
   * остальное (транспорт, фазы, точки останова) одинаково, поэтому и код общий.
   *
   * Ответ на `launch`/`attach` не ждём: DAP отвечает на него лишь после
   * `configurationDone`, и ожидание здесь сорвало бы отправку точек останова.
   *
   * `waitInitialized` включаем для подключения: там исход неочевиден (цель могла
   * не слушать), и рапортовать успех, пока адаптер не прислал `initialized`, нельзя.
   */
  private async openAdapter(
    spec: AdapterSpec,
    workingDir: string | undefined,
    command: 'launch' | 'attach',
    args: Record<string, unknown>,
    ready: string,
    waitInitialized = false,
  ): Promise<{ ok: boolean; message: string }> {
    this.stop();
    this.target = spec.adapterID === 'node' ? 'node' : 'python';
    this.initializedSeen = false;
    const env = mergeEnv(process.env, await this.env());

    this.setPhase('starting');
    try {
      this.child = spawn(spec.command, spec.args, {
        cwd: workingDir,
        // Довесок адаптера поверх окружения проекта (у Node — `ELECTRON_RUN_AS_NODE`).
        env: { ...env, ...spec.env },
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
        adapterID: spec.adapterID,
        clientID: 'chui',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
      });
    } catch (error) {
      this.stop();
      return { ok: false, message: `Не удалось запустить отладчик: ${error instanceof Error ? error.message : String(error)}` };
    }

    const request = this.call(command, args);
    if (!waitInitialized) {
      void request.catch((error) => this.publish(PushTopic.DebugOutput, { category: 'stderr', text: `${command}: ${error.message}` }));
      return { ok: true, message: ready };
    }

    // Подключение состоялось только когда пришло `initialized`: до него адаптер
    // ещё не готов, и «Отладка подключена» была бы неправдой — панель показала бы
    // успех при мёртвом соединении (см. `waitInitialized`).
    const trouble = await this.waitInitialized(request);
    if (trouble) {
      this.stop();
      return { ok: false, message: `Не удалось подключиться: ${trouble.message}` };
    }
    return { ok: true, message: ready };
  }

  /** Дождаться `initialized` или отказа запроса о подключении — что случится раньше. */
  private async waitInitialized(request: Promise<unknown>): Promise<Error | null> {
    const failure = request.then(() => null, (error: Error) => error);
    return Promise.race([
      this.awaitInitialized(REQUEST_TIMEOUT_MS).then((ok) => (ok ? null : new Error('отладчик не подтвердил подключение'))),
      failure,
    ]);
  }

  /**
   * Ждать событие `initialized`. Это единственный честный признак, что адаптер
   * подключился и готов принимать точки останова: ответ на `attach` приходит
   * раньше и сам по себе ничего не значит.
   */
  private awaitInitialized(timeoutMs: number): Promise<boolean> {
    if (this.initializedSeen) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout;
      const waiter = (ok: boolean): void => {
        clearTimeout(timer);
        resolve(ok);
      };
      timer = setTimeout(() => {
        this.initializedWaiters.delete(waiter);
        resolve(false);
      }, timeoutMs);
      this.initializedWaiters.add(waiter);
    });
  }

  /**
   * Подключиться к уже слушающему адаптеру по TCP.
   *
   * Так выглядит подключение к Python-процессу: `debugpy --listen` (как и вызов
   * `debugpy.listen` в самом скрипте) поднимает отдельный процесс-адаптер, который
   * слушает порт и говорит по DAP. Своего адаптера здесь поднимать нечего — он бы
   * ждал, пока цель подключится к нему, тогда как цель уже слушает сама. Отсюда
   * транспорт сокетом: тот же протокол, только не по stdio, а по сети.
   */
  private async openSocket(host: string, port: number, args: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    this.stop();
    this.target = 'python';
    this.initializedSeen = false;
    this.setPhase('starting');

    const socket = net.connect({ host, port });
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.feed(chunk));
    socket.on('error', (error: Error) => {
      // До handshake об ошибке сокета сообщит сам `attach` понятным текстом; писать
      // ещё и в вывод отладчика — только путать. После — это единственная весточка.
      if (this.socket !== socket || !this.initializedSeen) return;
      this.publish(PushTopic.DebugOutput, { category: 'stderr', text: `debugpy: ${error.message}` });
    });
    socket.on('close', () => {
      if (this.socket === socket) this.ended();
    });

    try {
      await this.waitConnected(socket);
    } catch (error) {
      this.socket = null;
      socket.destroy();
      this.clearSession('Подключение не состоялось');
      const why = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `Не удалось подключиться к ${host}:${port}: ${why}` };
    }

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
      return { ok: false, message: `Не удалось запустить отладчик: ${error instanceof Error ? error.message : String(error)}` };
    }

    const trouble = await this.waitInitialized(this.call('attach', args));
    if (trouble) {
      this.stop();
      return { ok: false, message: `Не удалось подключиться: ${trouble.message}` };
    }
    return { ok: true, message: 'Отладка подключена' };
  }

  /** Дождаться установления TCP-соединения: до него слать DAP некуда. */
  private waitConnected(socket: net.Socket): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        socket.off('connect', onConnect);
        socket.off('error', onError);
        if (error) reject(error);
        else resolve();
      };
      const onConnect = (): void => finish();
      const onError = (error: Error): void => finish(error);
      timer = setTimeout(() => finish(new Error('истекло время ожидания')), REQUEST_TIMEOUT_MS);
      socket.once('connect', onConnect);
      socket.once('error', onError);
    });
  }

  stop(): void {
    if (!this.child && !this.socket) return;
    // Мягко просим отключиться, пока транспорт ещё жив: после обнуления слать
    // уже некуда. Раньше процесс снимался до отправки, и `disconnect` не уходил
    // вовсе — адаптер не успевал закрыть цель сам.
    this.call('disconnect', { terminateDebuggee: true }, 1500).catch(() => undefined);
    const child = this.child;
    const socket = this.socket;
    this.child = null;
    this.socket = null;
    if (socket) socket.destroy();
    if (child) {
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          // уже мёртв
        }
      }, 300);
    }
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

  /**
   * Останов по исключению: какие исключения останавливают программу.
   *
   * Запрос можно слать и до старта: значение запомним и отдадим адаптеру при
   * инициализации (как и точки останова). Имена фильтров у адаптеров разные,
   * поэтому клиент даёт пару понятных флагов, а перевод — здесь.
   */
  async setExceptionBreakpoints(filters: { uncaught: boolean; caught: boolean }): Promise<void> {
    this.exceptions = { uncaught: filters.uncaught === true, caught: filters.caught === true };
    this.exceptionsSet = true;
    if (!this.child) return;
    await this.call('setExceptionBreakpoints', { filters: this.dapExceptionFilters() }).catch(() => undefined);
  }

  /**
   * Пара флагов → набор фильтров адаптера. У Node это `uncaught`/`caught` (их
   * понимает наш адаптер и сам переводит в `Debugger.setPauseOnExceptions`), а у
   * debugpy пойманные и необработанные называются `raised` и `uncaught`.
   */
  private dapExceptionFilters(): string[] {
    const filters: string[] = [];
    if (this.exceptions.uncaught) filters.push('uncaught');
    if (this.exceptions.caught) filters.push(this.target === 'python' ? 'raised' : 'caught');
    return filters;
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
    if (!this.child && !this.socket) return Promise.reject(new Error('Сессия отладки не запущена'));

    const seq = this.nextSeq;
    this.nextSeq += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`Отладчик не ответил на ${command}`));
      }, timeoutMs);
      this.pending.set(seq, { resolve, reject, timer });
      this.send({ seq, type: 'request', command, arguments: args });
    });
  }

  /** Запрос адаптеру: транспорт у сессии один — либо процесс по stdio, либо сокет. */
  private send(message: DapMessage): void {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const frame = `Content-Length: ${body.length}\r\n\r\n`;
    if (this.child) {
      this.child.stdin.write(frame);
      this.child.stdin.write(body);
      return;
    }
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(frame);
      this.socket.write(body);
    }
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
        // Подключение подтверждено: адаптер готов принять точки останова (см.
        // `waitInitialized`), а после них ждёт `configurationDone`, иначе
        // программа не начнёт выполняться.
        this.initializedSeen = true;
        for (const waiter of this.initializedWaiters) waiter(true);
        this.initializedWaiters.clear();
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

  /** Отправить все известные точки останова и настройки останова по исключению. */
  private async pushAllBreakpoints(): Promise<void> {
    for (const [path, lines] of this.breakpoints) {
      await this.setBreakpoints(path, lines).catch(() => undefined);
    }
    // Фильтры исключений — тоже до `configurationDone`. Шлём, только если их
    // задавал человек: у debugpy без этого свой набор по умолчанию, и трогать его
    // без просьбы не стоит.
    if (this.exceptionsSet) {
      await this.call('setExceptionBreakpoints', { filters: this.dapExceptionFilters() }).catch(() => undefined);
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
    if (this.phase === 'idle' && !this.child && !this.socket) return;
    this.child = null;
    this.socket = null;
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
    // Ждущих `initialized` не оставляем без ответа: иначе подключение зависнет.
    for (const waiter of this.initializedWaiters) waiter(false);
    this.initializedWaiters.clear();
    this.initializedSeen = false;
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
 * Программа на JavaScript или TypeScript: её отлаживает Node-адаптер, а не debugpy.
 *
 * Расширения TypeScript в списке нарочно: точку в `.ts` человек ставит сам, и
 * adapterID здесь не важен, а вот `debugpy` на таком файле — заведомо не тот
 * отладчик. Собранный `.ts` (Source-карта в `.js`) отлаживается через свой `.js`.
 */
function isNodeProgram(program: string): boolean {
  return /\.(c|m)?(js|ts)x?$/i.test(program);
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
