import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PushTopic,
  type LspDiagnostic,
  type LspServerConfig,
  type LspSettings,
} from '../../shared/api';
import { toProjectSymbols, type ProjectSymbol } from '../../shared/lsp-symbols';
import { mergeEnv } from '../project-env';

/**
 * Языковые серверы (LSP) в main-процессе.
 *
 * Своего анализатора в IDE нет, а тянуть в renderer полноценный LSP-клиент
 * поверх Monaco — отдельная большая работа. Здесь — минимум, дающий главное:
 * серверы запускаются по настройке, документы синхронизируются, а их пометки
 * (`publishDiagnostics`) уезжают в редактор тем же путём, что и его собственные.
 *
 * Повод вынести в main: сервер — внешний процесс, renderer к процессам доступа не имеет.
 */

/* ── JSON-RPC поверх stdio с фреймингом Content-Length ──────────────────── */

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

type NotificationHandler = (method: string, params: unknown) => void;
type RequestHandler = (method: string, params: unknown) => unknown | Promise<unknown>;

class JsonRpcConnection {
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onNotification: NotificationHandler,
    private readonly onRequest: RequestHandler,
  ) {
    child.stdout.on('data', (chunk: Buffer) => this.feed(chunk));
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  dispose(): void {
    for (const pending of this.pending.values()) pending.reject(new Error('Соединение закрыто'));
    this.pending.clear();
  }

  /** Разбор потока: заголовок `Content-Length: N` + тело из N байт. */
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

      let message: JsonRpcMessage;
      try {
        message = JSON.parse(body) as JsonRpcMessage;
      } catch {
        continue;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: JsonRpcMessage): void {
    // Ответ на наш запрос: id есть, method нет.
    if (message.id !== undefined && message.method === undefined) {
      const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
      if (!pending) return;
      this.pending.delete(message.id as number);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }

    // Запрос ОТ сервера: обязаны ответить, иначе сервер повиснет.
    if (message.id !== undefined && message.method !== undefined) {
      Promise.resolve()
        .then(() => this.onRequest(message.method!, message.params))
        .then((result) => this.send({ jsonrpc: '2.0', id: message.id, result: result ?? null }))
        .catch((error) => this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error) } }));
      return;
    }

    if (message.method) this.onNotification(message.method, message.params);
  }

  private send(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }
}

/* ── сервис серверов ────────────────────────────────────────────────────── */

interface ServerRuntime {
  readonly config: LspServerConfig;
  readonly child: ChildProcessWithoutNullStreams;
  readonly connection: JsonRpcConnection;
  readonly initialized: Promise<void>;
  readonly versions: Map<string, number>;
  /** Что сервер умеет: спрашивать то, чего нет, бессмысленно и вредно. */
  capabilities: LspCapabilities;
}

/** Подмножество возможностей сервера, по которым решаем, что у него просить. */
interface LspCapabilities {
  completionProvider?: { triggerCharacters?: string[] };
  hoverProvider?: boolean;
  definitionProvider?: boolean;
  signatureHelpProvider?: { triggerCharacters?: string[] };
  /** Поиск символов по всему проекту — «перейти к символу». */
  workspaceSymbolProvider?: boolean;
}

export class LspService {
  private readonly runtimes = new Map<string, ServerRuntime>();
  /** Подъёмы, которые ещё не завершились: ключ — язык. */
  private readonly starting = new Map<string, Promise<ServerRuntime | null>>();
  /** Номер поколения серверов: растёт при перезапуске, отсекает устаревшие подъёмы. */
  private generation = 0;
  private readonly languageOfPath = new Map<string, string>();

  constructor(
    private readonly root: () => string | null,
    private readonly settings: () => LspSettings,
    private readonly publish: (topic: string, payload: unknown) => void,
    /**
     * Интерпретатор Python проекта. Нужен, чтобы сервер видел пакеты окружения:
     * без него подсказки по импортам не поднимутся. Возвращает null — окружения нет.
     */
    private readonly pythonPath: () => string | null = () => null,
    /**
     * Переменные окружения проекта из `.env`. Языковой сервер запускается с ними:
     * плагины читают оттуда токены и пути, и тогда его картина мира совпадает с тем,
     * что видит код при запуске.
     */
    private readonly env: () => Promise<Record<string, string>> = async () => ({}),
  ) {}

  status(): { running: string[] } {
    return { running: [...this.runtimes.keys()] };
  }

  restart(): { running: string[] } {
    // Подъёмы, начатые до перезапуска, станут ненужными: счётчик версий их отсечёт.
    this.generation += 1;
    for (const language of [...this.runtimes.keys()]) this.stop(language);
    return { running: [] };
  }

  /** Открыть документ в подходящем сервере. Нет сервера для языка — тихо ничего не делаем. */
  async open(path: string, languageId: string, text: string): Promise<void> {
    const runtime = await this.runtimeFor(languageId);
    if (!runtime) return;

    this.languageOfPath.set(path, languageId);
    await runtime.initialized.catch(() => undefined);
    runtime.versions.set(path, 1);
    runtime.connection.notify('textDocument/didOpen', {
      textDocument: { uri: pathToFileURL(path).toString(), languageId, version: 1, text },
    });
  }

  change(path: string, text: string): void {
    const runtime = this.runtimeForPath(path);
    if (!runtime) return;
    const version = (runtime.versions.get(path) ?? 1) + 1;
    runtime.versions.set(path, version);
    // Полная синхронизация (sync kind 1): нам не нужно считать диапазоны самим.
    runtime.connection.notify('textDocument/didChange', {
      textDocument: { uri: pathToFileURL(path).toString(), version },
      contentChanges: [{ text }],
    });
    // Пометки пересчитываются сервером: старые гасим, чтобы не висели на экране.
    this.publish(PushTopic.LspDiagnostics, { path, diagnostics: [] });
  }

  close(path: string): void {
    const runtime = this.runtimeForPath(path);
    this.languageOfPath.delete(path);
    if (!runtime) return;
    runtime.versions.delete(path);
    runtime.connection.notify('textDocument/didClose', { textDocument: { uri: pathToFileURL(path).toString() } });
    this.publish(PushTopic.LspDiagnostics, { path, diagnostics: [] });
  }

  dispose(): void {
    this.generation += 1;
    for (const language of [...this.runtimes.keys()]) this.stop(language);
  }

  private runtimeForPath(path: string): ServerRuntime | null {
    const language = this.languageOfPath.get(path);
    return language ? (this.runtimes.get(language) ?? null) : null;
  }

  /**
   * Сервер поднимается лениво, при первом открытии файла этого языка.
   *
   * Подъём асинхронный (читаем `.env`), поэтому одного `runtimes.get` мало: два
   * файла одного языка, открытые разом, оба успели бы пройти проверку и запустить
   * по серверу — лишний остался бы висеть процессом. Поэтому второй ждёт тот же
   * незавершённый подъём.
   */
  private async runtimeFor(language: string): Promise<ServerRuntime | null> {
    const existing = this.runtimes.get(language);
    if (existing) return existing;

    const inFlight = this.starting.get(language);
    if (inFlight) return inFlight;

    const pending = this.startLanguage(language).finally(() => this.starting.delete(language));
    this.starting.set(language, pending);
    return pending;
  }

  private async startLanguage(language: string): Promise<ServerRuntime | null> {
    const settings = this.settings();
    if (!settings.enabled) return null;
    const config = settings.servers.find((server) => server.language === language && server.enabled && server.command.trim());
    if (!config) return null;

    // Пока поднимались, могли перезапустить серверы: тогда этот уже не нужен, и
    // его процесс надо убить — иначе он остался бы жить вне учёта.
    const generation = this.generation;
    try {
      const runtime = await this.start(config);
      if (generation !== this.generation) {
        this.kill(runtime);
        return null;
      }
      this.runtimes.set(language, runtime);
      return runtime;
    } catch {
      return null; // сервера нет в PATH — это не повод падать IDE
    }
  }

  private kill(runtime: ServerRuntime): void {
    runtime.connection.dispose();
    try {
      runtime.child.kill();
    } catch {
      // уже мёртв
    }
  }

  private async start(config: LspServerConfig): Promise<ServerRuntime> {
    const cwd = this.root() ?? process.cwd();
    // Языковой сервер видит `.env` проекта — тем же путём, что терминал и запуск.
    const env = mergeEnv(process.env, await this.env());
    const child = spawn(config.command, config.args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env,
    }) as ChildProcessWithoutNullStreams;

    const connection = new JsonRpcConnection(
      child,
      (method, params) => this.onNotification(method, params),
      (method, params) => this.onRequest(method, params),
    );

    // Сервер упал или завершился — забываем про него, при следующем файле поднимем снова.
    const forget = (): void => {
      connection.dispose();
      if (this.runtimes.get(config.language)?.connection === connection) this.runtimes.delete(config.language);
    };
    child.on('exit', forget);
    child.on('error', forget);

    const runtime: ServerRuntime = {
      config,
      child,
      connection,
      versions: new Map(),
      capabilities: {},
      initialized: Promise.resolve(),
    };
    // Инициализацию не ждём синхронно: didOpen уедет после неё (см. open()).
    (runtime as { initialized: Promise<void> }).initialized = this.initialize(runtime, cwd);
    return runtime;
  }

  private async initialize(runtime: ServerRuntime, cwd: string): Promise<void> {
    const python = this.pythonPath();
    const result = (await runtime.connection.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(cwd).toString(),
      clientInfo: { name: 'Chui IDE' },
      capabilities: {
        textDocument: {
          synchronization: {},
          completion: { completionItem: { snippetSupport: false } },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: {},
          signatureHelp: {},
        },
        // Серверы (pylsp, pyright) спрашивают настройки этим запросом.
        workspace: { configuration: true },
      },
      // Путь к питону передаём сразу: pyright берёт его отсюда, иначе не видит
      // пакеты окружения и подсказки по импортам не поднимаются.
      initializationOptions: python ? { pythonPath: python, settings: { python: { pythonPath: python } } } : undefined,
    })) as { capabilities?: LspCapabilities } | null;

    // Возможности решают, что можно спрашивать: их отсутствие — не ошибка.
    runtime.capabilities = result?.capabilities ?? {};
    runtime.connection.notify('initialized', {});
  }

  /**
   * Запрос к серверу по уже открытому документу: подсказки, наведение, переход.
   * Ошибка или отсутствие сервера — это `null`, а не сбой: без подсказок
   * редактор обязан работать дальше.
   */
  async request(path: string, method: string, params: unknown): Promise<unknown> {
    const runtime = this.runtimeForPath(path);
    if (!runtime) return null;
    await runtime.initialized.catch(() => undefined);
    try {
      return await runtime.connection.request(method, params);
    } catch {
      return null;
    }
  }

  /**
   * Символы проекта по запросу: классы, функции, переменные — по всем запущенным
   * серверам. Поиск не привязан к файлу, поэтому спрашиваем каждый сервер, у
   * которого это умеется: ответит тот, чей язык есть в проекте.
   */
  async projectSymbols(query: string): Promise<ProjectSymbol[]> {
    const results: ProjectSymbol[] = [];

    for (const runtime of [...this.runtimes.values()]) {
      if (!runtime.capabilities.workspaceSymbolProvider) continue;
      await runtime.initialized.catch(() => undefined);
      try {
        const raw = await runtime.connection.request('workspace/symbol', { query });
        results.push(...toProjectSymbols(raw, fileURLToPath));
      } catch {
        // Сервер не ответил — это не повод терять результаты остальных.
      }
    }

    return results;
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== 'textDocument/publishDiagnostics') return;
    const payload = params as { uri?: string; diagnostics?: unknown[] };
    if (typeof payload.uri !== 'string') return;
    // uri → путь: у сервиса свой корень, но file:// понимает и fileURLToPath.
    let path: string;
    try {
      path = fileURLToPath(payload.uri);
    } catch {
      return;
    }
    this.publish(PushTopic.LspDiagnostics, { path, diagnostics: toDiagnostics(payload.diagnostics) });
  }

  /** Запросы сервера к клиенту: отвечаем мягко, лишь бы не подвешивать его. */
  private onRequest(method: string, params: unknown): unknown {
    if (method === 'workspace/configuration') {
      const items = (params as { items?: Array<{ section?: string }> }).items ?? [];
      const python = this.pythonPath();
      return items.map((item) => (item.section === 'python' && python ? { pythonPath: python } : null));
    }
    return null;
  }

  private stop(language: string): void {
    const runtime = this.runtimes.get(language);
    if (!runtime) return;
    this.runtimes.delete(language);
    this.kill(runtime);
  }
}

/* ── разбор пометок LSP ─────────────────────────────────────────────────── */

const SEVERITY: Record<number, LspDiagnostic['severity']> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'info',
};

/** LSP-диагностика (0-based, severity 1..4) → наш формат (1-based, текстом). */
function toDiagnostics(raw: unknown): LspDiagnostic[] {
  if (!Array.isArray(raw)) return [];
  const out: LspDiagnostic[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const value = item as {
      range?: { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } };
      severity?: number;
      message?: unknown;
      source?: unknown;
    };
    const start = value.range?.start;
    const end = value.range?.end;
    if (!start || typeof start.line !== 'number' || typeof start.character !== 'number') continue;
    out.push({
      severity: SEVERITY[value.severity ?? 3] ?? 'info',
      line: start.line + 1,
      column: start.character + 1,
      endLine: typeof end?.line === 'number' ? end.line + 1 : start.line + 1,
      endColumn: typeof end?.character === 'number' ? end.character + 1 : start.character + 1,
      message: typeof value.message === 'string' ? value.message : String(value.message ?? ''),
      source: typeof value.source === 'string' ? value.source : undefined,
    });
  }
  return out;
}
