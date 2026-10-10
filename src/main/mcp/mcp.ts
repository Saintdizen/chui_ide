import { spawn, type ChildProcess } from 'node:child_process';
import type { McpServerTools } from '../../shared/api';
import { mcpToolResultText, parseMcpTools, type McpServerConfig, type McpToolInfo } from '../../shared/mcp';

/**
 * Внешние инструменты по Model Context Protocol.
 *
 * MCP-сервер — отдельный процесс, с которым говорят JSON-сообщениями по stdio,
 * по одному объекту на строку. Здесь только то, что нужно агенту: рукопожатие
 * (`initialize`), список инструментов (`tools/list`) и вызов (`tools/call`).
 *
 * Серверы запускает IDE по настройке, то есть команду задаёт человек, а не
 * модель: она влияет только на аргументы вызова. Поэтому запуск здесь — такое же
 * доверенное действие, как языковой сервер или отладчик.
 */

/** Версия протокола, которую объявляем: строкой, как её ждёт сервер. */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

/** Ответ на вызов инструмента: текст для модели и признак ошибки. */
export interface McpCallResult {
  text: string;
  isError: boolean;
}

/** Сколько ждём ответ на обычный запрос и на рукопожатие: старт бывает долгим. */
const REQUEST_TIMEOUT_MS = 20_000;
const HANDSHAKE_TIMEOUT_MS = 30_000;

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** Одно подключение к серверу: процесс, протокол и список его инструментов. */
class McpConnection {
  private child: ChildProcess | null = null;
  private buffer = '';
  private seq = 0;
  private readonly pending = new Map<number, PendingCall>();
  private toolList: McpToolInfo[] = [];
  private connecting: Promise<void> | null = null;

  constructor(
    private readonly config: McpServerConfig,
    private readonly cwd: string | null,
  ) {}

  get id(): string {
    return this.config.id;
  }

  tools(): readonly McpToolInfo[] {
    return this.toolList;
  }

  /** Подключиться один раз: параллельные вызовы ждут одно и то же рукопожатие. */
  connect(): Promise<void> {
    if (!this.connecting) {
      this.connecting = this.handshake().catch((error: unknown) => {
        // Неудачный старт не запоминаем: следующая попытка должна быть настоящей.
        this.connecting = null;
        this.stop();
        throw error instanceof Error ? error : new Error(String(error));
      });
    }
    return this.connecting;
  }

  private async handshake(): Promise<void> {
    const child = spawn(this.config.command, this.config.args, {
      cwd: this.cwd ?? undefined,
      env: { ...process.env, ...this.config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.feed(chunk));
    // Свой stderr сервер использует для диагностики: отдаём его в stderr IDE,
    // чтобы поломку было видно, но контекст модели этим не засоряем.
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) process.stderr.write(`[mcp:${this.config.id}] ${text}\n`);
    });
    child.on('error', (error) => this.failAll(new Error(`сервер ${this.config.id}: ${error.message}`)));
    child.on('close', (code) => this.failAll(new Error(`сервер ${this.config.id} завершился (код ${code ?? '—'})`)));

    await this.request(
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'chui_iDE', version: '1.0.0' },
      },
      HANDSHAKE_TIMEOUT_MS,
    );
    this.notify('notifications/initialized', {});

    const listed = await this.request('tools/list', {}, HANDSHAKE_TIMEOUT_MS);
    this.toolList = parseMcpTools(this.config.id, listed);
  }

  /** Пришёл кусок вывода: сообщения разделены переводом строки. */
  private feed(chunk: string): void {
    this.buffer += chunk;
    let at = this.buffer.indexOf('\n');
    while (at >= 0) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (line) this.handle(line);
      at = this.buffer.indexOf('\n');
    }
  }

  private handle(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // Не JSON — значит, сервер пишет диагностику в stdout вопреки протоколу.
      process.stderr.write(`[mcp:${this.config.id}] ${line}\n`);
      return;
    }

    const record = typeof message === 'object' && message !== null ? (message as Record<string, unknown>) : null;
    if (!record) return;

    // Запрос от сервера к клиенту: ответить обязательно, иначе сервер ждёт вечно.
    // Проверяем метод раньше ответов и `id` — любого типа: свои id выбирает каждый
    // из двоих, и сервер вправе взять строку (`roots/list` в примерах MCP именно
    // такая). Уведомление — то же, но без `id`: отвечать не на что.
    if (typeof record.method === 'string') {
      if (record.id === undefined) return;
      if (record.method === 'ping') {
        this.send({ jsonrpc: '2.0', id: record.id, result: {} });
        return;
      }
      this.send({
        jsonrpc: '2.0',
        id: record.id,
        error: { code: -32601, message: `Метод ${record.method} не поддерживается` },
      });
      return;
    }

    // Ответ на наш запрос: id у нас всегда число, поэтому сверяем по числу.
    if (typeof record.id === 'number' && ('result' in record || 'error' in record)) {
      const call = this.pending.get(record.id);
      if (!call) return;
      this.pending.delete(record.id);
      clearTimeout(call.timer);
      if (record.error) call.reject(new Error(describeRpcError(record.error)));
      else call.resolve(record.result);
    }
  }

  private send(message: unknown): void {
    const child = this.child;
    if (!child?.stdin?.writable) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin?.writable) return Promise.reject(new Error(`сервер ${this.config.id} не запущен`));

    this.seq += 1;
    const id = this.seq;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`сервер ${this.config.id}: нет ответа на ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /** Вызвать инструмент: ошибка протокола тоже возвращается текстом. */
  async call(toolName: string, args: Record<string, unknown>): Promise<McpCallResult> {
    try {
      const result = await this.request('tools/call', { name: toolName, arguments: args }, REQUEST_TIMEOUT_MS);
      return mcpToolResultText(result);
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), isError: true };
    }
  }

  private failAll(error: Error): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
  }

  stop(): void {
    this.failAll(new Error(`сервер ${this.config.id} остановлен`));
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      child.kill();
      // Если процесс не отреагировал сразу — добиваем: он наш, и он больше не нужен.
      child.unref?.();
    }
  }
}

/** Текст ошибки JSON-RPC: сервер присылает объект с кодом и сообщением. */
function describeRpcError(error: unknown): string {
  const record = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : null;
  const message = typeof record?.message === 'string' ? record.message : 'неизвестная ошибка';
  const code = typeof record?.code === 'number' ? ` (код ${record.code})` : '';
  return `${message}${code}`;
}

/**
 * Сервис внешних инструментов: держит подключения к серверам из настроек и
 * отдаёт объединённый список. Список кешируется — за один прогон агента он не
 * меняется, а запуск сервера стоит времени.
 */
export class McpService {
  private readonly connections = new Map<string, McpConnection>();
  private readonly index = new Map<string, { serverId: string; toolName: string }>();
  private cached: McpToolInfo[] | null = null;
  private signature = '';

  constructor(
    private readonly servers: () => readonly McpServerConfig[],
    private readonly cwd: () => string | null,
  ) {}

  /** Инструменты всех включённых серверов. Недоступный сервер не отменяет остальные. */
  async list(): Promise<McpToolInfo[]> {
    if (this.cached !== null && this.signature === this.currentSignature()) return this.cached;

    // Настройки изменились — прежние подключения недействительны.
    if (this.cached !== null) this.reset();
    this.signature = this.currentSignature();

    const all: McpToolInfo[] = [];
    for (const config of this.servers()) {
      if (!config.enabled) continue;
      const connection = this.connectionFor(config);
      try {
        await connection.connect();
      } catch (error) {
        // Сервер не поднялся: причину уже отдали в stderr, остальные работают.
        process.stderr.write(`[mcp:${config.id}] ${error instanceof Error ? error.message : String(error)}\n`);
        continue;
      }
      for (const tool of connection.tools()) {
        this.index.set(tool.exposedName, { serverId: tool.serverId, toolName: tool.toolName });
        all.push(tool);
      }
    }

    this.cached = all;
    return all;
  }

  /**
   * Состояние каждого сервера по отдельности — для проверки в настройках.
   *
   * В отличие от `list`, здесь кеш не используется: кнопка проверки затем и нужна,
   * чтобы поднять серверы заново и увидеть причину отказа. Ошибка одного сервера
   * не мешает показать остальные.
   */
  async status(): Promise<McpServerTools[]> {
    const out: McpServerTools[] = [];
    for (const config of this.servers()) {
      if (!config.enabled) {
        out.push({ id: config.id, error: 'сервер выключен', tools: [] });
        continue;
      }
      const connection = this.connectionFor(config);
      try {
        await connection.connect();
        out.push({
          id: config.id,
          tools: connection.tools().map((tool) => ({
            name: tool.toolName,
            description: tool.description,
            readOnly: tool.readOnly,
          })),
        });
      } catch (error) {
        out.push({ id: config.id, error: error instanceof Error ? error.message : String(error), tools: [] });
      }
    }
    return out;
  }

  /** Вызвать внешний инструмент по имени, которое видела модель. */
  async call(exposedName: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const target = this.index.get(exposedName);
    if (!target) {
      return {
        text: `Внешний инструмент «${exposedName}» сейчас недоступен: список серверов изменился или сервер не запустился. Перечитай список инструментов.`,
        isError: true,
      };
    }

    const connection = this.connections.get(target.serverId);
    if (!connection) return { text: `Сервер «${target.serverId}» не подключён`, isError: true };
    return connection.call(target.toolName, args);
  }

  /** Настройки серверов могли измениться: сравнение по подписи, без лишних перезапусков. */
  private currentSignature(): string {
    return JSON.stringify(
      this.servers().map((server) => ({
        id: server.id,
        command: server.command,
        args: server.args,
        env: server.env,
        enabled: server.enabled,
      })),
    );
  }

  private connectionFor(config: McpServerConfig): McpConnection {
    const existing = this.connections.get(config.id);
    if (existing) return existing;
    const created = new McpConnection(config, this.cwd());
    this.connections.set(config.id, created);
    return created;
  }

  private reset(): void {
    for (const connection of this.connections.values()) connection.stop();
    this.connections.clear();
    this.index.clear();
    this.cached = null;
  }

  dispose(): void {
    this.reset();
    this.signature = '';
  }
}
