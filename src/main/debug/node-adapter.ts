import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CdpConnection } from './cdp';
import { DapReader, encodeDap, type DapMessage } from './dap-framing';
import { inlineSourceMap, SourceMap } from './source-map';

/**
 * Отладочный адаптер Node: с одной стороны DAP, с другой — CDP.
 *
 * Node Inspector (`node --inspect-brk`) говорит на Chrome DevTools Protocol по
 * WebSocket, а панель отладки в IDE говорит на DAP по stdio. Адаптер — это
 * переводчик между ними: получает DAP-запросы (точки останова, стек, переменные,
 * шаги) и переводит их в вызовы `Debugger.*`/`Runtime.*`, а события инспектора
 * (`Debugger.paused`, вывод консоли) — обратно в DAP-события.
 *
 * Зачем свой адаптер, а не vscode-js-debug: тому нужны инъекция бутлоадера,
 * watchdog и TCP — всё ради дочерних процессов и auto-attach. Нам нужен один
 * процесс, `--inspect-brk` и CDP; это укладывается в один небольшой файл, без
 * зависимостей (`WebSocket` и `fetch` уже встроены в рантайм).
 *
 * Source-карты разбираем сами (`source-map.ts`): точка, поставленная в `.ts`,
 * ложится на нужную строку собранного `.js`, а кадр стека из `.js` показывается
 * в `.ts`. Карту берём по `sourceMapURL` события `scriptParsed` — в том числе
 * вложенную в файл `data:`-ссылкой.
 *
 * `condition` у точки понимает сам CDP. `hitCondition` и `logMessage` он не знает,
 * поэтому их считает и печатает адаптер: точка-счётчик молча пропускает останов,
 * пока попаданий мало, а точка-журнал печатает строку и идёт дальше.
 */

/** Отлаживаемый процесс однопоточный: у Node-инспектора поток всегда один. */
const THREAD_ID = 1;
/** Сколько ждать адрес инспектора в stderr: запуск Node — доли секунды. */
const INSPECTOR_TIMEOUT_MS = 10_000;

/** Объект CDP `RemoteObject` — то, что инспектор возвращает вместо значений. */
interface RemoteObject {
  type?: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  objectId?: string;
}

/** Кадр вызова из `Debugger.paused`. */
interface CallFrame {
  callFrameId: string;
  functionName?: string;
  url?: string;
  /**
   * Позиция кадра. `scriptId` обязателен: `url` в кадре останова CDP не отдаёт —
   * имя файла приходится искать по идентификатору скрипта из `scriptParsed`.
   */
  location: { scriptId?: string; lineNumber: number; columnNumber: number };
  scopeChain?: Array<{ type?: string; object?: RemoteObject; name?: string }>;
}

/** Аргументы DAP-запроса `launch`. Полей ровно столько, сколько мы понимаем. */
interface LaunchArgs {
  program?: string;
  cwd?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Чем запускать цель; по умолчанию `node` из PATH. */
  runtimeExecutable?: string;
}

/**
 * Аргументы DAP-запроса `attach`.
 *
 * Адрес инспектора приходит либо полями `host`/`port`, либо вложенным `connect` —
 * вторую форму использует debugpy, и клиент может прислать любую. Готовый `url`
 * (адрес CDP-канала) принимаем тоже: он избавляет от похода в HTTP-список целей.
 */
interface AttachArgs {
  url?: string;
  host?: string;
  port?: number;
  connect?: { host?: string; port?: number };
}

/** Точка останова в запросе `setBreakpoints`. */
interface SourceBreakpoint {
  line: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

/** Разобранный скрипт: где он лежит и есть ли у него source-карта. */
interface ScriptInfo {
  /** URL скрипта из CDP (`file://…` — файл на диске). */
  url: string;
  /** Путь файла, если скрипт загружен из файла. */
  path: string | null;
  /** Source-карта сгенерированного файла; её нет — сам файл и есть исходник. */
  map: SourceMap | null;
}

/** Что адаптер помнит о точке, поставленной в CDP. */
interface BreakpointMeta {
  /** Файл, в котором точку задал человек (может быть `.ts`). */
  file: string;
  /** Строка в этом файле — её и возвращаем клиенту как подтверждённую. */
  line: number;
  hitCondition?: string;
  logMessage?: string;
}

/** Куда в исполняемом коде ложится точка из файла клиента. */
interface BreakpointTarget {
  /** URL скрипта: им CDP адресует место (`file://…`). */
  url: string;
  /** Строка в скрипте, 1-based (как DAP); в CDP уйдёт нулём меньше. */
  line: number;
  /** Колонка в скрипте, 0-based (как CDP). */
  column: number;
  /** Карта, по которой позиция переведена, — ею же переводим ответ назад. */
  map: SourceMap | null;
}

export class NodeAdapter {
  private readonly reader: DapReader;
  private seq = 1;
  private child: ChildProcess | null = null;
  private cdp: CdpConnection | null = null;
  private launched = false;
  private configured = false;
  private shuttingDown = false;

  /** Адрес инспектора ещё не найден: резолвер ждёт строку из stderr. */
  private resolveInspectorUrl: ((url: string) => void) | null = null;
  private rejectInspectorUrl: ((error: Error) => void) | null = null;
  private stderrProbe = '';
  /** Программа ждёт нас на `--inspect-brk`: её надо разбудить, иначе она стоит. */
  private waitingForDebugger = false;

  /** Кадры текущего останова и их DAP-идентификаторы (индекс в массиве — общий). */
  private callFrames: CallFrame[] = [];
  private frameIds: number[] = [];
  private nextFrameId = 1;

  /** Ссылки переменных: DAP `variablesReference` → CDP `objectId`. Живут до останова. */
  private readonly refs = new Map<number, string>();
  private nextRef = 1;

  /** Точки останова по файлам: путь → идентификаторы CDP (для замены набора). */
  private readonly breakpointIds = new Map<string, string[]>();
  /** Настройки наших точек: счётчик попаданий и сообщение журнала CDP не знает. */
  private readonly breakpointMeta = new Map<string, BreakpointMeta>();
  /** Сколько раз сработала точка — счёт для `hitCondition`. */
  private readonly breakpointHits = new Map<string, number>();
  /** Файлы, которых ещё не знает ни один скрипт и ни одна карта: ждём их появления. */
  private readonly pendingSources = new Set<string>();
  /** Что просил клиент: набор нужен, чтобы повторить попытку позже. */
  private readonly wantedBreakpoints = new Map<string, SourceBreakpoint[]>();
  /** Постановка точек — по очереди: набор заменяется целиком, а скрипты идут пачкой. */
  private breakpointQueue: Promise<unknown> = Promise.resolve();

  /** Загруженные скрипты: идентификатор CDP → сведения о нём. */
  private readonly scripts = new Map<string, ScriptInfo>();
  /** Пути файлов, ставших скриптами: по ним точка ставится напрямую. */
  private readonly scriptPaths = new Set<string>();
  /** Source-карты по пути сгенерированного файла — для перевода кадров стека. */
  private readonly mapsByPath = new Map<string, SourceMap>();

  /** Показали ли останов клиенту: только тогда «продолжено» имеет смысл сообщать. */
  private reportedStopped = false;
  /** Останов на входе (`--inspect-brk`) уже снят: второй раз его снимать нечего. */
  private entryResumed = false;

  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
  ) {
    this.reader = new DapReader((message) => this.onMessage(message));
  }

  /** Начать слушать stdin: с этого момента приходят DAP-запросы. */
  run(): void {
    this.input.on('data', (chunk: Buffer | string) => {
      this.reader.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    this.input.on('end', () => this.shutdown(false));
  }

  /* ── приём DAP ─────────────────────────────────────────────────────────── */

  private onMessage(message: DapMessage): void {
    if (message.type !== 'request') return;
    void this.handleRequest(message).catch((error) => {
      this.respondError(message, error instanceof Error ? error.message : String(error));
    });
  }

  private async handleRequest(request: DapMessage): Promise<void> {
    const args = (request.arguments ?? {}) as Record<string, unknown>;
    switch (request.command) {
      case 'initialize':
        this.respond(request, {
          supportsConfigurationDoneRequest: true,
          supportsConditionalBreakpoints: true,
          supportsHitConditionalBreakpoints: true,
          supportsLogPoints: true,
          supportsEvaluateForHovers: true,
          supportsSetVariable: true,
          supportsSetExpression: true,
          supportsTerminateRequest: true,
        });
        break;

      case 'launch':
        await this.launch(args as LaunchArgs);
        this.respond(request);
        this.event('initialized', {});
        break;

      case 'attach':
        await this.attach(args as AttachArgs);
        this.respond(request);
        this.event('initialized', {});
        break;

      case 'configurationDone':
        await this.onConfigured();
        this.respond(request);
        break;

      case 'setBreakpoints':
        this.respond(request, { breakpoints: await this.setBreakpoints(args) });
        break;

      case 'setExceptionBreakpoints':
      case 'setFunctionBreakpoints':
        this.respond(request, { breakpoints: [] });
        break;

      case 'threads':
        this.respond(request, { threads: [{ id: THREAD_ID, name: 'main' }] });
        break;

      case 'stackTrace':
        this.respond(request, this.stackTrace());
        break;

      case 'scopes':
        this.respond(request, { scopes: this.scopes(args) });
        break;

      case 'variables':
        this.respond(request, { variables: await this.variables(args) });
        break;

      case 'continue':
        await this.debuggerResume('continue');
        this.respond(request, { allThreadsContinued: true });
        break;

      case 'next':
        await this.debuggerResume('stepOver');
        this.respond(request);
        break;

      case 'stepIn':
        await this.debuggerResume('stepInto');
        this.respond(request);
        break;

      case 'stepOut':
        await this.debuggerResume('stepOut');
        this.respond(request);
        break;

      case 'pause':
        await this.requireCdp().send('Debugger.pause');
        this.respond(request);
        break;

      case 'evaluate':
        this.respond(request, await this.evaluate(args));
        break;

      case 'setVariable':
        this.respond(request, await this.setVariable(args));
        break;

      case 'setExpression':
        this.respond(request, await this.setExpression(args));
        break;

      case 'disconnect':
      case 'terminate':
        this.respond(request);
        this.shutdown(true);
        break;

      default:
        // Незнакомую команду подтверждаем пустым ответом: молчание подвесило бы клиента.
        this.respond(request);
    }
  }

  /* ── запуск ────────────────────────────────────────────────────────────── */

  private async launch(args: LaunchArgs): Promise<void> {
    if (this.launched) throw new Error('Сессия отладки уже запущена');
    const cwd = args.cwd ?? process.cwd();
    const program = path.isAbsolute(args.program ?? '') ? (args.program as string) : path.resolve(cwd, args.program ?? '');
    const nodeExe = args.runtimeExecutable || 'node';
    const childArgs = ['--inspect-brk=127.0.0.1:0', program, ...(args.args ?? [])];

    const urlPromise = new Promise<string>((resolve, reject) => {
      this.resolveInspectorUrl = resolve;
      this.rejectInspectorUrl = reject;
    });

    const child = spawn(nodeExe, childArgs, {
      cwd,
      env: debuggeeEnv(args.env),
      // stdin не наследуем: наш stdin занят DAP-каналом.
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    child.stdout?.on('data', (chunk: Buffer) => this.event('output', { category: 'stdout', output: chunk.toString('utf8') }));
    child.stderr?.on('data', (chunk: Buffer) => this.onDebuggeeStderr(chunk));
    child.on('error', (error) => this.failInspector(error));
    child.on('exit', (code) => this.onDebuggeeExit(code));

    // Программа остановлена на входе и ждёт нас: без `runIfWaitingForDebugger`
    // (в `onConfigured`) она с места не сдвинется.
    this.waitingForDebugger = true;

    const url = await withTimeout(urlPromise, INSPECTOR_TIMEOUT_MS, 'Отладчик не открыл порт инспектора');
    await this.useInspector(url);
  }

  /**
   * Подключиться к уже работающему процессу.
   *
   * Процесс поднял не отладчик, поэтому адрес CDP-канала узнаём у него самого:
   * `--inspect` открывает HTTP-список целей по своему порту, а `WebSocket` лежит
   * в поле цели. Процесс при этом не останавливается: перезапускать чужую работу
   * отладка не вправе.
   */
  private async attach(args: AttachArgs): Promise<void> {
    if (this.launched) throw new Error('Сессия отладки уже запущена');
    const host = args.host?.trim() || '127.0.0.1';
    const port = Number(args.port ?? args.connect?.port);
    if (!Number.isInteger(port) || port <= 0) throw new Error('Не указан порт отлаживаемого процесса');
    await this.useInspector(await inspectorSocketUrl(host, port));
  }

  /** Общая часть запуска и подключения: подписки на события CDP и включение режимов. */
  private async useInspector(url: string): Promise<void> {
    const cdp = await CdpConnection.connect(url);
    this.cdp = cdp;
    cdp.onClose(() => this.onCdpClosed());
    cdp.on('Debugger.paused', (params) => this.onPaused(params));
    cdp.on('Debugger.resumed', () => this.onResumed());
    // Скрипты приходят пачкой сразу после `Debugger.enable`: без них не найти ни
    // сгенерированный файл для точки в `.ts`, ни source-карту для кадров стека.
    cdp.on('Debugger.scriptParsed', (params) => this.onScriptParsed(params));

    // Debugger включает точки останова, стек и переменные; Runtime нужен для
    // вычисления выражений вне кадра. Вывод программы берём из stdout процесса, а
    // не из `Runtime.consoleAPICalled`: иначе `console.log` дублировался бы.
    await cdp.send('Runtime.enable');
    await cdp.send('Debugger.enable');
    this.launched = true;
  }

  /** Разрешить программе идти: до этого она ждёт отладчик на `--inspect-brk`. */
  private async onConfigured(): Promise<void> {
    this.configured = true;
    // Подключённый процесс никто не держал: будить его не нужно и вредно — он бы
    // пошёл дальше по нажатию «продолжить», а не по нашему молчаливому вызову.
    if (!this.waitingForDebugger) return;
    await this.cdp?.send('Runtime.runIfWaitingForDebugger').catch(() => undefined);
  }

  private onDebuggeeStderr(chunk: Buffer): void {
    const text = chunk.toString('utf8');

    // Адрес инспектора Node печатает в stderr: `Debugger listening on ws://…`.
    // Собираем в буфер — строка может прийти кусками.
    if (this.resolveInspectorUrl) {
      this.stderrProbe += text;
      const match = /ws:\/\/\S+/.exec(this.stderrProbe);
      if (match) {
        const resolve = this.resolveInspectorUrl;
        this.resolveInspectorUrl = null;
        this.rejectInspectorUrl = null;
        resolve(match[0]);
      }
    }

    // Служебные строки Node в вывод программы не пускаем: это шум отладчика.
    // «Waiting for the debugger to disconnect» печатается, когда программа
    // закончилась, а отладчик ещё подключён, — к её выводу это не относится.
    const clean = text
      .replace(/Debugger listening on ws:\/\/\S+/g, '')
      .replace(/For help, see: https:\/\/nodejs\.org\/\S*/g, '')
      .replace(/Debugger attached\./g, '')
      .replace(/Waiting for the debugger to disconnect\.\.\./g, '');
    if (clean.trim()) this.event('output', { category: 'stderr', output: clean });
  }

  private failInspector(error: Error): void {
    const reject = this.rejectInspectorUrl;
    if (!reject) return;
    this.resolveInspectorUrl = null;
    this.rejectInspectorUrl = null;
    reject(error);
  }

  private onDebuggeeExit(code: number | null): void {
    // Выход до подключения — это провал запуска (нет файла, синтаксис и т.п.).
    this.failInspector(new Error(`Процесс завершился до подключения отладчика (код ${code ?? 'нет'})`));
    this.event('exited', { exitCode: code ?? 0 });
    this.event('terminated', {});
    this.shutdown(false);
  }

  private onCdpClosed(): void {
    if (this.shuttingDown) return;
    this.event('terminated', {});
    this.shutdown(false);
  }

  /* ── точки останова ────────────────────────────────────────────────────── */

  private async setBreakpoints(args: Record<string, unknown>): Promise<unknown[]> {
    const source = (args.source ?? {}) as { path?: string };
    const wanted = (args.breakpoints ?? []) as SourceBreakpoint[];
    const file = source.path;
    if (!file) return wanted.map((item) => ({ verified: false, line: item.line }));

    if (wanted.length === 0) this.wantedBreakpoints.delete(file);
    else this.wantedBreakpoints.set(file, wanted);

    // Через очередь: скрипты загружаются пачкой, и постановка из разных поводов
    // правила бы одно и то же состояние — набор мог бы остаться наполовину снятым.
    return this.queueBreakpoints(() => this.applyBreakpoints(file, wanted));
  }

  /**
   * Поставить точки файла в CDP. Набор заменяется целиком: прежние точки файла
   * снимаем, новые ставим — как велит DAP.
   *
   * Место точки ищется двумя путями, и оба пробуем. Прямой: файл адресуется как
   * есть — так работают обычные `.js`, и CDP помнит такую точку, даже если скрипт
   * ещё не загружен. Через карту: позицию файла знает source-карта собранного
   * скрипта (`.ts`, собранный в другой каталог) — тогда настоящее место в сборке.
   *
   * Ставим оба, потому что заранее неизвестно, каким путём точка сработает: файл
   * может быть и сборкой, и исходником чужой сборки. Лишняя точка в несуществующем
   * URL безвредна — она просто никогда не сработает.
   */
  private async applyBreakpoints(file: string, wanted: SourceBreakpoint[]): Promise<Array<{ verified: boolean; line: number }>> {
    const cdp = this.cdp;
    if (!cdp) return wanted.map((item) => ({ verified: false, line: item.line }));

    await this.removeBreakpoints(file);

    const result: Array<{ verified: boolean; line: number }> = [];
    const ids: string[] = [];

    for (const item of wanted) {
      let verified = false;
      // Строка по умолчанию — та, что задал человек; карта может её уточнить.
      let line = item.line;

      for (const target of this.targetsFor(file, item.line)) {
        try {
          // url, а не scriptId: файл может быть ещё не разобран — точка станет
          // отложенной и «выстрелит», когда скрипт загрузится.
          const response = await cdp.send('Debugger.setBreakpointByUrl', {
            url: target.url,
            lineNumber: target.line - 1,
            columnNumber: target.column,
            ...(item.condition ? { condition: item.condition } : {}),
          });
          const id = typeof response.breakpointId === 'string' ? response.breakpointId : '';
          if (!id) continue;
          ids.push(id);
          this.breakpointMeta.set(id, {
            file,
            line: item.line,
            ...(item.hitCondition ? { hitCondition: item.hitCondition } : {}),
            ...(item.logMessage ? { logMessage: item.logMessage } : {}),
          });
          verified = true;
          // У собранного файла ответ CDP — его позиция: переводим обратно в исходник.
          if (hasLocations(response)) line = this.actualLine(target.map, response, item.line);
        } catch {
          // Один из способов не удался — второй ещё может сработать.
        }
      }

      result.push({ verified, line });
    }

    this.breakpointIds.set(file, ids);
    // Файл, которого нет среди скриптов и которого не знает ни одна карта, ещё
    // может оказаться исходником сборки, чей скрипт не загрузился: подержим в
    // отложенных, чтобы добавить перевод, когда карта появится.
    if (this.scriptPaths.has(file) || this.hasMapFor(file)) this.pendingSources.delete(file);
    else this.pendingSources.add(file);
    return result;
  }

  /** Снять точки файла, поставленные нами, и забыть их настройки. */
  private async removeBreakpoints(file: string): Promise<void> {
    for (const id of this.breakpointIds.get(file) ?? []) {
      await this.cdp?.send('Debugger.removeBreakpoint', { breakpointId: id }).catch(() => undefined);
      this.breakpointMeta.delete(id);
      this.breakpointHits.delete(id);
    }
    this.breakpointIds.delete(file);
  }

  /**
   * Куда в исполняемом коде ложится точка файла — все возможные места.
   *
   * Первым идёт прямое: файл адресуется своим URL, позиция не меняется. Затем —
   * места из карт, которые знают этот файл исходником. Прямое первое не случайно:
   * для `.js` оно и есть настоящее, а перевод по карте нужен, когда файл в сборку
   * не попадал (например, `.ts`).
   */
  private targetsFor(file: string, line: number): BreakpointTarget[] {
    const targets: BreakpointTarget[] = [{ url: pathToFileURL(file).toString(), line, column: 0, map: null }];

    for (const script of this.scripts.values()) {
      const map = script.map;
      if (!map || !map.hasSource(file)) continue;
      const generated = map.generatedPositionFor(file, line - 1, 0);
      if (generated) targets.push({ url: script.url, line: generated.line + 1, column: generated.column, map });
    }
    return targets;
  }

  /**
   * Строка, которую CDP подтвердил, — в координатах файла клиента.
   *
   * Отладчик вправе сдвинуть точку (пустая строка, закрывающая скобка). Для
   * собранного файла его строка — не то, что ждёт человек: переводим ответ картой
   * обратно в исходник, а не отдаём строку `.js`.
   */
  private actualLine(map: SourceMap | null, response: Record<string, unknown>, fallback: number): number {
    const locations = Array.isArray(response.locations)
      ? (response.locations as Array<{ lineNumber?: number; columnNumber?: number }>)
      : [];
    const location = locations[0];
    if (!location || typeof location.lineNumber !== 'number') return fallback;
    if (!map) return location.lineNumber + 1;
    const original = map.originalPositionFor(location.lineNumber, location.columnNumber ?? 0);
    return original ? original.line + 1 : fallback;
  }

  /** Постановка точек по очереди: задачи правят одно состояние и должны не смешиваться. */
  private queueBreakpoints<T>(task: () => Promise<T>): Promise<T> {
    const next = this.breakpointQueue.then(task, task);
    this.breakpointQueue = next.catch(() => undefined);
    return next;
  }

  /* ── скрипты и source-карты ────────────────────────────────────────────── */

  /** Скрипт загружен: запоминаем его и доставляем точки, которым он был нужен. */
  private onScriptParsed(params: Record<string, unknown>): void {
    const scriptId = String(params.scriptId ?? '');
    const url = typeof params.url === 'string' ? params.url : '';
    if (!scriptId || !url) return;

    const file = urlToPath(url);
    const info: ScriptInfo = { url, path: file, map: null };
    this.scripts.set(scriptId, info);
    if (file) this.scriptPaths.add(file);

    const mapUrl = typeof params.sourceMapURL === 'string' ? params.sourceMapURL : '';
    if (mapUrl) this.loadSourceMap(info, mapUrl);
    if (!file) return;
    // Файл стал скриптом — точка в нём ставится напрямую, отложенной её держать
    // больше незачем. Чтение карты синхронное, поэтому чтение и повтор идут следом.
    this.pendingSources.delete(file);
    this.retryPending();
  }

  /**
   * Прочитать source-карту скрипта. Ошибка чтения — не беда: точки просто
   * останутся в координатах собранного файла, а отладка продолжится.
   *
   * Локальная карта читается синхронно (обычный случай — файл рядом со сборкой):
   * так карта готова до того, как программа сойдёт с останова на входе, и точка
   * в `.ts` успевает встать. За картой по сети идём отдельно и доставляем позже.
   */
  private loadSourceMap(info: ScriptInfo, url: string): void {
    if (!info.path) return;

    const inline = inlineSourceMap(url);
    if (inline !== null) {
      this.indexSourceMap(info, inline);
      return;
    }

    // Ссылка без схемы — путь к файлу, причём относительный: `tsc` пишет просто
    // `app.js.map`, и считать его надо от каталога скрипта, а не от cwd.
    const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
    const file = isUrl
      ? url.startsWith('file:')
        ? fileURLToPath(url)
        : null
      : path.resolve(path.dirname(info.path), url);

    if (file !== null) {
      try {
        this.indexSourceMap(info, readFileSync(file, 'utf8'));
      } catch {
        // Карты нет или файл не читается — обойдёмся без неё.
      }
      return;
    }

    // Карта не на диске (обычно по http) — сходим за ней и доставим точки позже.
    void fetch(url)
      .then((response) => (response.ok ? response.text() : null))
      .then((text) => {
        if (text) this.indexSourceMap(info, text);
      })
      .catch(() => undefined);
  }

  /** Разобрать карту скрипта и запомнить её: по ней переводятся точки и кадры. */
  private indexSourceMap(info: ScriptInfo, text: string): void {
    if (!info.path) return;
    const map = SourceMap.parse(text, path.dirname(info.path));
    if (!map) return;
    info.map = map;
    this.mapsByPath.set(info.path, map);
    this.retryPending();
  }

  /** Есть ли карта, которая знает этот файл исходником. */
  private hasMapFor(file: string): boolean {
    for (const script of this.scripts.values()) {
      if (script.map?.hasSource(file)) return true;
    }
    return false;
  }

  /**
   * Повторить постановку точек, которые ждали карту.
   *
   * Повторяем только те файлы, для которых карта теперь есть: иначе каждый новый
   * скрипт снова и снова снимал бы и ставил одни и те же точки.
   */
  private retryPending(): void {
    if (this.pendingSources.size === 0) return;
    for (const file of [...this.pendingSources]) {
      if (!this.hasMapFor(file)) continue;
      const wanted = this.wantedBreakpoints.get(file);
      if (!wanted) {
        this.pendingSources.delete(file);
        continue;
      }
      void this.queueBreakpoints(() => this.applyBreakpoints(file, wanted));
    }
  }

  /* ── стек, области, переменные ─────────────────────────────────────────── */

  private stackTrace(): Record<string, unknown> {
    const frames = this.callFrames.map((frame, index) => {
      // Имя файла берём по `scriptId`: в самом кадре останова CDP его не шлёт.
      const file = urlToPath(frame.url || this.scripts.get(String(frame.location.scriptId))?.url || '');
      // Кадр из собранного файла показываем в исходнике: человек открыл `.ts`, а не
      // `.js`, и стек должен вести туда, где он поставил точку.
      const map = file ? this.mapsByPath.get(file) : null;
      const original = map?.originalPositionFor(frame.location.lineNumber, frame.location.columnNumber);
      const source = original?.source ?? file;
      return {
        id: this.frameIds[index],
        name: frame.functionName || '(анонимная функция)',
        line: (original?.line ?? frame.location.lineNumber) + 1,
        column: (original?.column ?? frame.location.columnNumber) + 1,
        ...(source ? { source: { name: path.basename(source), path: source } } : {}),
      };
    });
    return { stackFrames: frames, totalFrames: frames.length };
  }

  private scopes(args: Record<string, unknown>): Array<{ name: string; variablesReference: number; expensive: boolean }> {
    const frame = this.frameFor(args.frameId);
    if (!frame?.scopeChain) return [];
    return frame.scopeChain.map((scope) => ({
      name: scopeName(scope.type),
      variablesReference: this.addRef(scope.object?.objectId),
      expensive: false,
    }));
  }

  private async variables(args: Record<string, unknown>): Promise<unknown[]> {
    const objectId = this.refs.get(Number(args.variablesReference));
    if (!objectId || !this.cdp) return [];
    const response = await this.cdp.send('Runtime.getProperties', { objectId, ownProperties: true });
    const properties = (response.result as Array<{ name?: string; value?: RemoteObject }> | undefined) ?? [];
    const out: Array<{ name: string; value: string; type: string | null; variablesReference: number }> = [];
    for (const property of properties) {
      const value = property.value;
      if (!value || typeof property.name !== 'string' || property.name === '__proto__') continue;
      out.push({
        name: property.name,
        value: describeValue(value),
        type: value.type ?? null,
        variablesReference: this.addRef(value.objectId),
      });
    }
    return out;
  }

  /* ── вычисления и присваивания ─────────────────────────────────────────── */

  private async evaluate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const expression = String(args.expression ?? '').trim();
    if (!expression) return { result: '', type: null, variablesReference: 0 };

    const callFrameId = this.frameFor(args.frameId)?.callFrameId ?? null;
    const response = callFrameId
      ? await this.requireCdp().send('Debugger.evaluateOnCallFrame', { callFrameId, expression, returnByValue: false })
      : await this.requireCdp().send('Runtime.evaluate', { expression, returnByValue: false });

    const exception = response.exceptionDetails as { text?: string; exception?: RemoteObject } | undefined;
    if (exception) throw new Error(exception.text ?? describeValue(exception.exception ?? {}));

    const value = (response.result ?? {}) as RemoteObject;
    return { result: describeValue(value), type: value.type ?? null, variablesReference: this.addRef(value.objectId) };
  }

  private async setVariable(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const objectId = this.refs.get(Number(args.variablesReference));
    const name = String(args.name ?? '');
    const raw = String(args.value ?? '');
    if (!objectId || !name) throw new Error('Переменная недоступна для изменения');

    // Значение вводит человек, и оно может быть числом, строкой или выражением.
    // Поэтому не подставляем его как строку, а выполняем присваивание в объекте.
    const response = await this.requireCdp().send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function(){ return this[${JSON.stringify(name)}] = (${raw}); }`,
      returnByValue: false,
    });
    const value = (response.result ?? {}) as RemoteObject;
    return { value: describeValue(value), type: value.type ?? null, variablesReference: this.addRef(value.objectId) };
  }

  private async setExpression(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const expression = String(args.expression ?? '').trim();
    const raw = String(args.value ?? '');
    if (!expression) throw new Error('Пустое выражение');

    const assignment = `${expression} = (${raw})`;
    const callFrameId = this.frameFor(args.frameId)?.callFrameId ?? null;
    const response = callFrameId
      ? await this.requireCdp().send('Debugger.evaluateOnCallFrame', { callFrameId, expression: assignment })
      : await this.requireCdp().send('Runtime.evaluate', { expression: assignment });
    const value = (response.result ?? {}) as RemoteObject;
    return { value: describeValue(value), type: value.type ?? null, variablesReference: this.addRef(value.objectId) };
  }

  /* ── события CDP → DAP ─────────────────────────────────────────────────── */

  private onPaused(params: Record<string, unknown>): void {
    this.callFrames = (params.callFrames as CallFrame[] | undefined) ?? [];
    this.frameIds = this.callFrames.map(() => this.nextFrameId++);
    // Ссылки переменных живут в пределах останова: у нового кадра свои objectId.
    this.refs.clear();

    // Останов до конца настройки — это `--inspect-brk` на входе: программу снимет
    // `Runtime.runIfWaitingForDebugger`, и показывать клиенту тут нечего.
    if (!this.configured) return;
    void this.handleStop(params);
  }

  /**
   * Решить, показывать останов или пройти мимо.
   *
   * `condition` CDP проверяет сам и до останова не допускает. А `hitCondition` и
   * `logMessage` он не знает: останов приходит, и адаптер сам решает, что с ним
   * делать, — пропустить, пока попаданий мало, напечатать строку журнала и идти
   * дальше или показать останов клиенту.
   */
  private async handleStop(params: Record<string, unknown>): Promise<void> {
    const hits = (params.hitBreakpoints as string[] | undefined) ?? [];

    // Останов на входе: `--inspect-brk` останавливает программу на первой строке
    // после `runIfWaitingForDebugger`, то есть уже после настройки. Клиент такого
    // останова не просил и не ждёт — снимаем его сами, иначе программа так и стояла
    // бы на входе. Перед этим даём доехать постановке точек: её могла отложить
    // загрузка скриптов, а программа сейчас пойдёт вперёд и точку бы проскочила.
    if (!this.entryResumed && hits.length === 0 && /start/i.test(String(params.reason ?? ''))) {
      this.entryResumed = true;
      await this.breakpointQueue.catch(() => undefined);
      await this.debuggerResume('continue');
      return;
    }

    // Пусто — останов не от точки (пауза, шаг, исключение): его показываем как есть.
    let shouldStop = hits.length === 0;
    let shouldResume = false;

    for (const id of hits) {
      const meta = this.breakpointMeta.get(id);
      if (!meta) {
        // Чужая точка (например, оставшаяся от прошлой сессии): ведём себя обычно.
        shouldStop = true;
        continue;
      }
      if (meta.hitCondition) {
        const count = (this.breakpointHits.get(id) ?? 0) + 1;
        this.breakpointHits.set(id, count);
        if (!hitConditionSatisfied(meta.hitCondition, count)) {
          shouldResume = true;
          continue;
        }
      }
      if (meta.logMessage) {
        await this.emitLogPoint(meta.logMessage);
        shouldResume = true;
        continue;
      }
      shouldStop = true;
    }

    if (shouldStop) {
      this.reportedStopped = true;
      this.event('stopped', { reason: mapReason(params.reason), threadId: THREAD_ID, allThreadsStopped: true });
      return;
    }
    // Точка-журнал или непройденный счётчик: клиент останова не видит, программа идёт.
    if (shouldResume) await this.debuggerResume('continue');
  }

  /** Точка-журнал: напечатать сообщение с подставленными значениями и продолжить. */
  private async emitLogPoint(message: string): Promise<void> {
    const text = await this.interpolateLog(message);
    this.event('output', { category: 'console', output: `${text}\n` });
  }

  /** Подставить в сообщение журнала значения `{выражения}`, посчитанные в кадре. */
  private async interpolateLog(message: string): Promise<string> {
    const frame = this.callFrames[0];
    let text = '';
    for (const part of splitLogMessage(message)) {
      if ('literal' in part) {
        text += part.literal;
        continue;
      }
      if (!frame) {
        text += `{${part.expression}}`;
        continue;
      }
      try {
        const response = await this.requireCdp().send('Debugger.evaluateOnCallFrame', {
          callFrameId: frame.callFrameId,
          expression: part.expression,
          returnByValue: false,
        });
        text += formatLogValue((response.result ?? {}) as RemoteObject);
      } catch {
        // Плохое выражение в сообщении — печатаем его как есть: ронять из-за этого
        // весь останов и терять остальные значения значило бы наказать за опечатку.
        text += `{${part.expression}}`;
      }
    }
    return text;
  }

  private onResumed(): void {
    this.callFrames = [];
    this.frameIds = [];
    this.refs.clear();
    // «Продолжено» говорим только после показанного останова: точка-журнал и вход
    // по `--inspect-brk` продолжают программу, но клиент об останове не знал.
    if (!this.reportedStopped) return;
    this.reportedStopped = false;
    this.event('continued', { threadId: THREAD_ID, allThreadsContinued: true });
  }

  /* ── управление ────────────────────────────────────────────────────────── */

  private async debuggerResume(command: 'continue' | 'stepOver' | 'stepInto' | 'stepOut'): Promise<void> {
    const method = command === 'continue' ? 'Debugger.resume' : `Debugger.${command}`;
    await this.requireCdp().send(method).catch(() => undefined);
  }

  private shutdown(killDebuggee: boolean): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.cdp?.close();
    this.cdp = null;
    const child = this.child;
    this.child = null;
    if (killDebuggee && child) {
      try {
        child.kill();
      } catch {
        // уже мёртв
      }
    }
  }

  /* ── мелкие помощники ──────────────────────────────────────────────────── */

  private frameFor(frameId: unknown): CallFrame | null {
    const index = this.frameIds.indexOf(Number(frameId));
    return index >= 0 ? this.callFrames[index] : null;
  }

  private addRef(objectId: string | undefined): number {
    if (!objectId) return 0;
    const ref = this.nextRef;
    this.nextRef += 1;
    this.refs.set(ref, objectId);
    return ref;
  }

  private requireCdp(): CdpConnection {
    if (!this.cdp) throw new Error('Отладчик не запущен');
    return this.cdp;
  }

  private respond(request: DapMessage, body: Record<string, unknown> = {}): void {
    this.write({ seq: this.seq++, type: 'response', request_seq: request.seq, success: true, command: request.command, body });
  }

  private respondError(request: DapMessage, message: string): void {
    this.write({ seq: this.seq++, type: 'response', request_seq: request.seq, success: false, command: request.command, message });
  }

  private event(event: string, body: Record<string, unknown>): void {
    this.write({ seq: this.seq++, type: 'event', event, body });
  }

  private write(message: DapMessage): void {
    try {
      this.output.write(encodeDap(message));
    } catch {
      // Поток закрылся — писать некуда; молчание здесь безопаснее падения.
    }
  }
}

/** Ответил ли CDP конкретным местом: по нему точку можно уточнить (и перевести). */
function hasLocations(response: Record<string, unknown>): boolean {
  return Array.isArray(response.locations) && response.locations.length > 0;
}

/**
 * Адрес CDP-канала процесса, запущенного с `--inspect`.
 *
 * Сам порт инспектора — не `WebSocket`: Node отдаёт по нему HTTP-список целей
 * (`/json/list`), и уже в цели лежит адрес `ws://…`, к которому подключаются.
 * Так же устроен и Chrome, поэтому приём общий для обоих.
 */
async function inspectorSocketUrl(host: string, port: number): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`http://${host}:${port}/json/list`);
  } catch {
    throw new Error(`Процесс на ${host}:${port} не отвечает: запущен ли он с --inspect?`);
  }
  if (!response.ok) throw new Error(`Процесс на ${host}:${port} не отдал список целей отладки`);

  const targets = (await response.json()) as Array<{ webSocketDebuggerUrl?: string }>;
  const url = targets.find((target) => typeof target.webSocketDebuggerUrl === 'string')?.webSocketDebuggerUrl;
  if (!url) throw new Error(`У процесса на ${host}:${port} нет отлаживаемой цели`);
  return url;
}

/** Разбор сообщения журнала: литералы и `{выражения}`, которые надо посчитать. */
function splitLogMessage(message: string): Array<{ literal: string } | { expression: string }> {
  const parts: Array<{ literal: string } | { expression: string }> = [];
  let literal = '';
  let index = 0;
  while (index < message.length) {
    const char = message[index];
    if (char === '{') {
      // `{{` — это один символ `{`, а не начало выражения.
      if (message[index + 1] === '{') {
        literal += '{';
        index += 2;
        continue;
      }
      const close = message.indexOf('}', index + 1);
      if (close < 0) {
        literal += char;
        index += 1;
        continue;
      }
      if (literal) parts.push({ literal });
      literal = '';
      parts.push({ expression: message.slice(index + 1, close) });
      index = close + 1;
      continue;
    }
    if (char === '}' && message[index + 1] === '}') {
      literal += '}';
      index += 2;
      continue;
    }
    literal += char;
    index += 1;
  }
  if (literal) parts.push({ literal });
  return parts;
}

/** Значение для строки журнала: строку печатаем как есть, остальное — описанием. */
function formatLogValue(object: RemoteObject): string {
  if (object.type === 'string') return String(object.value ?? '');
  return describeValue(object);
}

/**
 * Условие попаданий: `5` — ровно пятое, `>5`, `>=5`, `<5`, `<=5` — сравнение,
 * `%5` — каждое пятое. Непонятую запись считаем пройденной: точка с опечаткой
 * должна останавливать, а не молчать — молчащая точка выглядит как сломанная.
 */
function hitConditionSatisfied(spec: string, count: number): boolean {
  const match = /^(>=|<=|>|<|%|==)?\s*(\d+)$/.exec(spec.trim());
  if (!match) return true;
  const value = Number(match[2]);
  switch (match[1]) {
    case '>':
      return count > value;
    case '>=':
      return count >= value;
    case '<':
      return count < value;
    case '<=':
      return count <= value;
    case '%':
      return value > 0 && count % value === 0;
    default:
      return count === value;
  }
}

/** Окружение отлаживаемой программы: своё поверх унаследованного от адаптера. */
function debuggeeEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Адаптер сам запущен как Node (ELECTRON_RUN_AS_NODE): цели это не нужно.
  delete env.ELECTRON_RUN_AS_NODE;
  return extra ? { ...env, ...extra } : env;
}

/** Путь из `url` кадра CDP (`file://…`); не файл — `null`. */
function urlToPath(url: unknown): string | null {
  if (typeof url !== 'string' || !url.startsWith('file:')) return null;
  try {
    return fileURLToPath(url);
  } catch {
    return null;
  }
}

/** Значение `RemoteObject` в строку для панели: строки в кавычках, объекты — описанием. */
function describeValue(object: RemoteObject): string {
  if (object.type === 'string') return JSON.stringify(object.value ?? '');
  if (object.type === 'undefined') return 'undefined';
  if (object.value !== undefined) return String(object.value);
  const text = typeof object.description === 'string' ? object.description : (object.type ?? '');
  return text.length > 180 ? `${text.slice(0, 177)}…` : text;
}

/** Причина останова CDP → привычная причина DAP. */
function mapReason(reason: unknown): string {
  switch (reason) {
    case 'step':
      return 'step';
    case 'exception':
    case 'promiseRejection':
    case 'assert':
      return 'exception';
    case 'debugCommand':
      return 'pause';
    default:
      return typeof reason === 'string' && /start/i.test(reason) ? 'entry' : 'breakpoint';
  }
}

/** Имя области видимости: тип CDP → человеческое название. */
function scopeName(type: unknown): string {
  switch (type) {
    case 'local':
      return 'Локальные';
    case 'closure':
      return 'Внешние';
    case 'global':
      return 'Глобальные';
    case 'block':
      return 'Блок';
    case 'script':
    case 'module':
      return 'Модуль';
    case 'catch':
      return 'catch';
    default:
      return typeof type === 'string' ? type : 'значения';
  }
}

/** Промис с ограничением по времени: иначе ожидание адреса инспектора повисло бы. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
