import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PushTopic, type LspDiagnostic, type LspServerConfig, type LspSettings } from '../../shared/api';
import { downgradeSeverity } from '../../shared/lsp-severity';
import type { LspServerOrigin, LspStatus } from '../../shared/lsp-status';
import { exitReason } from '../../shared/lsp-status';
import type { FileEdit } from '../../shared/edits';
import { toWorkspaceFileEdits } from '../../shared/lsp-workspace-edit';
import { languageInfoForPath } from '../../shared/languages';
import { listProjectFiles } from '../project/scan';
import { prewarmLanguages, serverCandidates } from '../../shared/lsp-bundled';
import { toLocations, type SymbolLocation } from '../../shared/lsp-locations';
import { parseProgress } from '../../shared/lsp-progress';
import { negotiateEncoding, toServerColumn, type PositionEncoding } from '../../shared/position-encoding';
import {
  STANDARD_TOKEN_MODIFIERS,
  STANDARD_TOKEN_TYPES,
  applySemanticDelta,
  decodeSemanticTokens,
  type SemanticDelta,
  type SemanticLegend,
  type SemanticToken,
} from '../../shared/lsp-semantic-tokens';
import {
  mergeSymbols,
  toFileSymbols,
  toProjectSymbols,
  type FileSymbol,
  type ProjectSymbol,
} from '../../shared/lsp-symbols';
import { toFormatEdits } from '../../shared/lsp-formatting';
import type { TextEdit } from '../../shared/edits';
import { mergeEnv } from '../project-env';

/**
 * Языковые серверы (LSP) в main-процессе.
 *
 * Своего анализатора в IDE нет, а тянуть в renderer полноценный LSP-клиент —
 * отдельная большая работа. Здесь — минимум, дающий главное:
 * серверы запускаются по настройке, документы синхронизируются, а их пометки
 * (`publishDiagnostics`) уезжают в редактор тем же путём, что и его собственные.
 *
 * Повод вынести в main: сервер — внешний процесс, renderer к процессам доступа не имеет.
 */

/**
 * Сколько ждать ответа на `initialize`. Сервер, молчащий на `initialize` (например,
 * `pylsp`, падающий в своём коде и не отвечающий вовсе), не должен вешать язык:
 * по таймауту отдаём его цепочке как неудачный и пробуем следующего кандидата.
 */
const INITIALIZE_TIMEOUT_MS = 15_000;

/**
 * Строка для обхода проекта (`workspace/symbol`). Именно РЕДКАЯ, а не пустая:
 * обход нужен ради построенного индекса, а не ради списка, а пустой запрос в ответ
 * присылает все символы проекта — на большом репозитории это сотни тысяч записей
 * и мегабайты разбора ради того, что мы всё равно выбрасываем.
 */
const PROJECT_SCAN_QUERY = 'chui-project-scan';

/**
 * Сколько ждать сервер в поиске символов, когда ответ уже есть в карте символов.
 *
 * Поиск идёт на каждой набранной букве, и ответ карты — мгновенный; ждать ещё
 * секунды поднявшегося сервера значило бы держать перед человеком «ищу…» без причины.
 */
const INDEX_FIRST_WAIT_MS = 300;

/**
 * Второй источник объявлений — карта символов проекта (`main/symbols/indexer.ts`).
 *
 * Своего разбора у неё нет: объявления в неё кладёт тот же сервер, но собранные
 * заранее и лежащие на диске. Поэтому карта отвечает мгновенно и тогда, когда
 * сервера ещё нет (поднимается, не установлен, упал) — это и есть «глупый режим»,
 * в котором поиск символов не молчит.
 */
export interface SymbolIndexSource {
  find(query: string, limit?: number): ProjectSymbol[];
}

/**
 * Сколько ждать обхода проекта (`workspace/symbol`). Обход — это разбор всех файлов
 * проекта, и на большом репозитории он идёт секундами: предел щедрый, но не
 * бесконечный — не дождавшись, отпускаем сервер спокойно, индекс догреется сам.
 */
const PROJECT_SCAN_TIMEOUT_MS = 60_000;

/**
 * Сколько файлов проекта держим открытыми серверу разом при сборе пометок. Пометки
 * приходят своим темпом, и ждать их по одному файлу — минуты впустую; пачка держит
 * сервер занятым, но не заваливает его сотнями `didOpen` сразу.
 */
const SWEEP_CONCURRENCY = 24;

/**
 * Сколько ждём пометок по одному файлу. Срок нужен молчащим серверам (и файлам вне
 * проекта в `tsconfig`): иначе документ держал бы сервер вечно и обход не кончился бы.
 */
const SWEEP_FILE_WAIT_MS = 4_000;

/** Сколько файлов вообще берём в заход: за этим пределом счётчик не стоит обхода. */
const SWEEP_MAX_FILES = 4_000;

/** Файл больше этого — не документ проекта, а свалка: читать его в сервер незачем. */
const SWEEP_MAX_BYTES = 2_000_000;

/**
 * Запросы к документу, у которых свежий запрос вытесняет устаревший. Набор идёт быстрее,
 * чем отвечает сервер, и досказывать то, что уже не нужно, — трата сил сервера. Прочие
 * запросы (initialize, rename, форматирование) не отменяем: у них результат нужен.
 */
const CANCELLABLE_METHODS: ReadonlySet<string> = new Set([
  'textDocument/completion',
  'completionItem/resolve',
  'textDocument/hover',
  'textDocument/signatureHelp',
  'textDocument/codeAction',
  'textDocument/codeLens',
  'textDocument/inlayHint',
  'textDocument/foldingRange',
  'textDocument/selectionRange',
  'textDocument/documentSymbol',
  'textDocument/semanticTokens/full',
]);

/**
 * Легенда сервера: по ней читаются индексы в ответе. Сервер объявляет её при initialize;
 * нет легенды (или она не той формы) — разбирать нечем, и токены не берём.
 */
function semanticLegend(
  provider: { legend?: { tokenTypes?: unknown; tokenModifiers?: unknown } } | undefined,
): SemanticLegend | null {
  const types = provider?.legend?.tokenTypes;
  if (!Array.isArray(types)) return null;
  const modifiers = provider?.legend?.tokenModifiers;
  return {
    tokenTypes: types.filter((item): item is string => typeof item === 'string'),
    tokenModifiers: Array.isArray(modifiers)
      ? modifiers.filter((item): item is string => typeof item === 'string')
      : [],
  };
}

/** Промис с пределом ожидания: по истечении срока — ошибка с понятной причиной. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Таймаут: ${what}`)), ms);
    (timer as { unref?: () => void }).unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

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

/**
 * Ошибка запроса сервера к клиенту с кодом JSON-RPC. Нужна там, где ответить «успехом»
 * нельзя: на незнакомый запрос спецификация велит отвечать `MethodNotFound`, а не пустым
 * результатом — иначе сервер решит, что клиент это умеет (например, что регистрация
 * возможности удалась), и будет ждать поведения, которого нет.
 */
class RpcRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'RpcRequestError';
  }
}

class JsonRpcConnection {
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      partial?: string;
      /** Токен индикатора прогресса, открытого сервером под этот запрос. */
      progress?: string | number;
    }
  >();
  /** Номер запроса по ключу «вид запроса»: по нему отменяем устаревшие (см. `request`). */
  private readonly pendingByKey = new Map<string, number>();
  /**
   * Частичные результаты по токену: сервер отдаёт длинный ответ кусками (`$/progress`),
   * чтобы не ждать конца поиска. Копим их здесь и склеиваем с основным ответом.
   */
  private readonly partials = new Map<string, unknown[]>();

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onNotification: NotificationHandler,
    private readonly onRequest: RequestHandler,
    /** Куда отдавать весь обмен (для журнала трассировки). Не задано — журнал выключен. */
    private readonly onTraffic?: (direction: 'client' | 'server', message: unknown) => void,
  ) {
    child.stdout.on('data', (chunk: Buffer) => this.feed(chunk));
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  request(method: string, params: unknown, cancelKey?: string, options: { partial?: boolean } = {}): Promise<unknown> {
    // Новый запрос того же вида по тому же файлу отменяет прежде начатый: набор идёт
    // быстрее, чем отвечает сервер, и досказывать то, что уже не нужно, незачем.
    if (cancelKey) {
      const previous = this.pendingByKey.get(cancelKey);
      if (previous !== undefined) this.cancel(previous);
    }
    const id = this.nextId;
    this.nextId += 1;
    if (cancelKey) this.pendingByKey.set(cancelKey, id);

    // Частичные результаты: даём серверу свой токен в запросе и копим то, что он пришлёт
    // кусками (см. `dispatch`). Длинный поиск ссылок так начинается раньше конца.
    let partial: string | undefined;
    // Свой токен прогресса: по нему сервер сообщает, что начал работу, а мы знаем,
    // чей это индикатор — без токена связь пришлось бы угадывать.
    let workDone: string | undefined;
    let outParams = params;
    if (options.partial && params && typeof params === 'object') {
      partial = `partial-${id}`;
      outParams = {
        ...(params as Record<string, unknown>),
        partialResultToken: partial,
      };
      this.partials.set(partial, []);
    }
    if (params && typeof params === 'object') {
      workDone = `work-${id}`;
      outParams = { ...(outParams as Record<string, unknown>), workDoneToken: workDone };
    }

    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        ...(partial ? { partial } : {}),
        ...(workDone ? { progress: workDone } : {}),
      });
      this.send({ jsonrpc: '2.0', id, method, params: outParams });
    });
  }

  /**
   * Отменить запрос: уведомление `$/cancelRequest` (как говорит спецификация) и сразу
   * отказ по своему обещанию — иначе отменённый запрос висел бы до ответа сервера.
   */
  cancel(id: number): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.partial) this.partials.delete(pending.partial);
    this.forgetKey(id);
    this.send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } });
    // Отмены запроса мало: если сервер открыл под него индикатор прогресса, он
    // продолжает работу до `workDoneProgress/cancel`. Спецификация требует сказать
    // и это — иначе индекс строится в холостую до конца.
    if (pending.progress !== undefined) {
      this.notify('window/workDoneProgress/cancel', { token: pending.progress });
    }
    pending.reject(new Error('Запрос отменён'));
  }

  /**
   * Забрать кусок частичного результата, если токен наш. `true` — уведомление наше и
   * обрабатывать его дальше (публиковать как прогресс) не нужно.
   */
  private collectPartial(params: unknown): boolean {
    if (this.partials.size === 0 || !params || typeof params !== 'object') return false;
    const { token, value } = params as { token?: unknown; value?: unknown };
    const key = typeof token === 'string' || typeof token === 'number' ? String(token) : null;
    if (key === null || !this.partials.has(key)) return false;
    const items = Array.isArray(value) ? value : ((value as { items?: unknown } | null)?.items ?? null);
    if (Array.isArray(items)) this.partials.get(key)!.push(...items);
    return true;
  }

  /**
   * Привязать прогресс сервера к ждущему запросу: в `$/progress` с `workDoneProgress`
   * токен говорит, чей это работа. Запоминаем его в одном ждущем запросе — по нему
   * потом отменяем и саму работу (`window/workDoneProgress/cancel`).
   */
  private bindProgress(params: unknown): void {
    if (this.pending.size === 0 || !params || typeof params !== 'object') return;
    const { token, value } = params as { token?: unknown; value?: unknown };
    if (typeof token !== 'string' && typeof token !== 'number') return;
    if ((value as { kind?: unknown } | null)?.kind !== 'begin') return;
    // Токен наш (`work-<номер>`), если запрос его назвал: тогда запись точная.
    const own = typeof token === 'string' ? /^work-(\d+)$/.exec(token) : null;
    if (own) {
      const pending = this.pending.get(Number(own[1]));
      if (pending) pending.progress = token;
      return;
    }
    // Чужой — привязываем к самому старому ждущему: точнее сказать нечего.
    const oldest = this.pending.keys().next();
    if (oldest.done) return;
    const pending = this.pending.get(oldest.value);
    if (pending && pending.progress === undefined) pending.progress = token;
  }

  /** Снять ключ отмены, если он указывает на этот номер запроса. */
  private forgetKey(id: number): void {
    for (const [key, value] of this.pendingByKey) if (value === id) this.pendingByKey.delete(key);
  }

  dispose(): void {
    for (const pending of this.pending.values()) pending.reject(new Error('Соединение закрыто'));
    this.pending.clear();
    this.pendingByKey.clear();
    this.partials.clear();
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
    this.onTraffic?.('server', message);
    // Частичный результат: пришёл уведомлением по нашему токену — копим и дальше не отдаём.
    if (message.method === '$/progress' && this.collectPartial(message.params)) return;
    // Тот же `$/progress` с `begin` говорит, что сервер начал работу — запоминаем,
    // чтобы отмена запроса погасила и её.
    if (message.method === '$/progress') this.bindProgress(message.params);

    // Ответ на наш запрос: id есть, method нет.
    if (message.id !== undefined && message.method === undefined) {
      const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
      if (!pending) return;
      this.pending.delete(message.id as number);
      if (typeof message.id === 'number') this.forgetKey(message.id);
      if (message.error) {
        if (pending.partial) this.partials.delete(pending.partial);
        pending.reject(new Error(message.error.message));
        return;
      }
      // Частичные куски важнее конца: склеиваем их с основным ответом (он — массив).
      let result = message.result;
      if (pending.partial) {
        const collected = this.partials.get(pending.partial) ?? [];
        this.partials.delete(pending.partial);
        if (collected.length > 0 && Array.isArray(result)) result = [...collected, ...result];
        else if (collected.length > 0 && result === undefined) result = collected;
      }
      pending.resolve(result);
      return;
    }

    // Запрос ОТ сервера: обязаны ответить, иначе сервер повиснет.
    if (message.id !== undefined && message.method !== undefined) {
      Promise.resolve()
        .then(() => this.onRequest(message.method!, message.params))
        .then((result) => this.send({ jsonrpc: '2.0', id: message.id, result: result ?? null }))
        .catch((error) => {
          // Наш код ошибки уважаем (MethodNotFound), прочее — внутренняя ошибка.
          const code = error instanceof RpcRequestError ? error.code : -32603;
          this.send({
            jsonrpc: '2.0',
            id: message.id,
            error: { code, message: String(error?.message ?? error) },
          });
        });
      return;
    }

    if (message.method) this.onNotification(message.method, message.params);
  }

  private send(message: unknown): void {
    this.onTraffic?.('client', message);
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
  /**
   * В чём сервер считает колонки: `utf-16` по умолчанию, `utf-32` — если он его
   * потребовал. Ставится после `initialize` (см. `negotiateEncoding`) и
   * применяется при переводе колонок (см. `toServerColumn`/`fromServerColumn`).
   */
  positionEncoding: PositionEncoding;
}

/** Подмножество возможностей сервера, по которым решаем, что у него просить. */
interface LspCapabilities {
  /**
   * В чём сервер считает колонки в позициях. По протоколу — строка или список
   * (старые серверы отвечают массивом). Нет поля — utf-16.
   */
  positionEncoding?: string | string[];
  completionProvider?: {
    /** По каким знакам сервер сам готов открывать список подсказок (`.` в TS, `@` в CSS, `:` в JSON Schema). */
    triggerCharacters?: string[];
    /** Знаки, которые сервер считает «принять подсказку» (Enter, Tab и подобные). */
    allCommitCharacters?: string[];
    /** Умеет ли сервер доводить элемент отдельным запросом (`completionItem/resolve`). */
    resolveProvider?: boolean;
  };
  hoverProvider?: boolean;
  /** Сервер умеет серые подсказки вперёд (`textDocument/inlineCompletion`). */
  inlineCompletionProvider?: unknown;
  definitionProvider?: boolean;
  /** Родственные `definition`: объявление, тип, реализации. */
  declarationProvider?: unknown;
  typeDefinitionProvider?: unknown;
  implementationProvider?: unknown;
  /** Сохранение объявлено (`textDocumentSync.save`) — значит, `didSave` слать. */
  textDocumentSyncSave?: { includeText: boolean };
  /** Объявлен ли `willSave` (`textDocumentSync.willSave`): сообщать ДО записи. */
  textDocumentSyncWillSave?: boolean;
  /** Сервер готов форматировать при сохранении (`willSaveWaitUntil`). */
  textDocumentSyncWillSaveWaitUntil?: boolean;
  /** Наблюдение за файлами вне редактора (`workspace.didChangeWatchedFiles`). */
  workspaceWatchedFiles?: boolean;
  /** Сервер попросил уведомлять его об операциях с файлами (`workspace.fileOperations`). */
  workspaceFileOperations?: boolean;
  /** Сервер просит присылать `workspace/didChangeConfiguration`. */
  workspaceConfiguration?: boolean;
  /** Сервер умеет многокорневую область (`workspace.workspaceFolders`). */
  workspaceFolders?: boolean;
  signatureHelpProvider?: { triggerCharacters?: string[] };
  /** Поиск символов по всему проекту — «перейти к символу». */
  workspaceSymbolProvider?: boolean;
  /** Объявления внутри файла: на них строится скелет файла для агента. */
  documentSymbolProvider?: boolean;
  /** Ссылки на символ по всему проекту — «найти все ссылки». */
  referencesProvider?: boolean;
  /** Переименование символа с учётом семантики — «переименовать» в редакторе. */
  renameProvider?: unknown;
  /**
   * Форматирование участка (`rangeFormatting`). Есть — можем отформатировать выделение
   * и только что вставленный кусок, не переписывая файл целиком инструментом проекта.
   */
  documentRangeFormattingProvider?: unknown;
  /** Умеет ли сервер отформатировать файл целиком (`textDocument/formatting`). */
  documentFormattingProvider?: unknown;
  /** Точная семантическая подсветка: по ней разбираем ответ (легенду объявляет сервер). */
  semanticTokensProvider?: {
    legend?: { tokenTypes?: unknown; tokenModifiers?: unknown };
    /** Умеет отвечать про участок файла, а не только про файл целиком. */
    range?: unknown;
    /** Умеет присылать правки к прежним токенам (`full/delta`). */
  };
  /**
   * Диагностика по запросу (`textDocument/diagnostic`), а не по публикации.
   *
   * `publishDiagnostics` серверы шлют сами и только про открытые файлы; в
   * проекте, где правят один файл, остальные проверяются «когда-нибудь». С pull
   * мы спрашиваем сами и получаем пометки про файл, которого сервер не открывал.
   */
  diagnosticProvider?: unknown;
}

/** Возможности синхронизации: `save` из `textDocumentSync` и наблюдение за файлами. */
function withSyncCapabilities(capabilities: unknown): LspCapabilities {
  const caps = (capabilities ?? {}) as Record<string, unknown>;
  const sync = caps.textDocumentSync as { save?: unknown } | undefined;
  const workspace = caps.workspace as
    | {
        didChangeWatchedFiles?: unknown;
        fileOperations?: unknown;
        didChangeConfiguration?: unknown;
        workspaceFolders?: unknown;
      }
    | undefined;
  const operations = workspace?.fileOperations as { didCreate?: unknown } | undefined;
  const save = sync && typeof sync === 'object' ? sync.save : undefined;
  const syncSave =
    save === true
      ? { includeText: false }
      : save && typeof save === 'object'
        ? { includeText: (save as { includeText?: unknown }).includeText === true }
        : undefined;
  return {
    ...(caps as LspCapabilities),
    ...(syncSave ? { textDocumentSyncSave: syncSave } : {}),
    textDocumentSyncWillSave: Boolean((sync as { willSave?: unknown } | undefined)?.willSave),
    // Форматирование при сохранении: сервер сам скажет, что записать вместо файла.
    textDocumentSyncWillSaveWaitUntil: Boolean(
      (sync as { willSaveWaitUntil?: unknown } | undefined)?.willSaveWaitUntil,
    ),
    workspaceWatchedFiles: Boolean(workspace?.didChangeWatchedFiles),
    workspaceFileOperations: Boolean(operations?.didCreate),
    workspaceConfiguration: workspace?.didChangeConfiguration !== undefined,
    workspaceFolders: workspace?.workspaceFolders === true,
  };
}

/**
 * Фильтр файловых операций «любой файл»: сервер просит его в объявлении
 * `fileOperations`. Сузить нечем — о созданиях и удалениях нам надо знать
 * про любой файл проекта, иначе часть модулей останется для сервера невидимой.
 */
const UNFILTERED_FILE_OPERATION = { scheme: 'file', pattern: '**/*' };

/** Строка в `insertText` LSP: бывает либо строкой, либо `StringValue`. */
function insertTextOf(value: unknown): string {
  if (typeof value === 'string') return value;
  const text = (value as { value?: unknown } | null)?.value;
  return typeof text === 'string' ? text : '';
}

/**
 * Позиция для запроса к серверу: строка 0-based и `character` в ТОЙ кодировке,
 * о которой договорились при `initialize`.
 *
 * Редактор присылает колонку 1-based в UTF-16-единицах. Для `utf-16` это уже
 * готовое число (`column - 1`); для `utf-32` — пересчитываем по тексту строки:
 * улыбка перед курсом занимает в UTF-16 два знака, а сервер ждёт один код.
 * Строку берём из присланного текста — она уже под рукой у каждого вызова.
 */
function positionOf(
  runtime: ServerRuntime,
  text: string,
  line: number,
  column: number,
): { line: number; character: number } {
  const zeroLine = Math.max(line - 1, 0);
  const utf16 = Math.max(column - 1, 0);
  if (runtime.positionEncoding === 'utf-16') return { line: zeroLine, character: utf16 };
  const lineText = text.split('\n')[zeroLine] ?? '';
  return { line: zeroLine, character: toServerColumn(lineText, utf16, 'utf-32') };
}

/** Подсказки вперёд: `insertText` строкой или `StringValue`, с откатом на `label`. */
function toInlineSnippets(result: unknown): string[] {
  const list = Array.isArray(result) ? result : ((result as { items?: unknown } | null)?.items ?? []);
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    const raw = item as { insertText?: unknown; label?: unknown } | null;
    const text = insertTextOf(raw?.insertText) || (typeof raw?.label === 'string' ? raw.label : '');
    if (text) out.push(text);
  }
  return out;
}

/** Символ без `location` — сервер просит доспросить его отдельно. */
function isUnresolvedSymbol(item: unknown): boolean {
  return Boolean(item) && typeof item === 'object' && !('location' in (item as object));
}

/** Разбор ответа `prepareRename`.
 *
 * Ответ по спецификации — `Range` или `{range, placeholder}`. `Range` без имени
 * значит «можно, но имя не подскажем»: тогда окно откроется с пустым полем.
 * Отказ приходит ОШИБКОЙ запроса (код `RequestFailed`) — её ловит вызывающий и
 * передаёт `message` человеку как причину.
 */
function toPrepareRename(raw: unknown): { word: string; message: string | null } | null {
  // Отказ сервера (`RequestFailed`) — не ответ, а ошибка запроса: текст причины
  // сообщает вызывающий, здесь её взять неоткуда.
  if (typeof raw === 'string') return { word: '', message: raw };
  if (!raw || typeof raw !== 'object') return null;
  const word = (raw as { placeholder?: unknown }).placeholder;
  const asString = typeof word === 'string' ? word : '';
  const message = (raw as { message?: unknown }).message;
  return { word: asString, message: typeof message === 'string' ? message : null };
}

export class LspService {
  private readonly runtimes = new Map<string, ServerRuntime>();
  /** Подъёмы, которые ещё не завершились: ключ — язык. */
  private readonly starting = new Map<string, Promise<ServerRuntime | null>>();
  /**
   * Открытия, которые ещё в пути (`open` не вернулся). Запрос к файлу ждёт их:
   * renderer шлёт `lsp.open` без ожидания, и запрос на дополнение мог обогнать
   * его — сервер отвечал по неоткрытому документу, то есть пустотой.
   */
  private readonly opening = new Map<string, Promise<void>>();
  /** Номер поколения серверов: растёт при перезапуске, отсекает устаревшие подъёмы. */
  private generation = 0;
  private readonly languageOfPath = new Map<string, string>();
  /**
   * Последний текст документа, о котором мы знаем. Нужен потому, что правка может
   * обогнать открытие: сервер поднимается секундами, а человек печатает уже сейчас.
   * Если `didOpen` уйдёт с текстом, каким он был в начале подъёма, сервер будет
   * разбирать устаревший код — и подчёркивать то, чего на экране давно нет.
   */
  private readonly latestText = new Map<string, string>();
  /** В каком сервере документ уже открыт (`didOpen` ушёл). Нет записи — ещё не открыт. */
  private readonly openedIn = new Map<string, ServerRuntime>();
  /** Прежние числа семантических токенов: для `full/delta`. Сбрасывается на `close`. */
  private readonly semanticCache = new Map<string, { resultId: string; data: number[] }>();
  /** Прежние пометки по запросу: `unchanged` отвечает «то же, что и в прошлый раз». */
  private readonly pullState = new Map<string, { resultId: string; items: LspDiagnostic[] }>();
  /**
   * Языки, сервер которых поднять не удалось: язык → причина. Без кэша каждый файл
   * такого языка заново искал бы сервер (диск, PATH, окружения) — на пустом ответе
   * это дорого и ничего не меняет. Снимается перезапуском (`restart`).
   */
  private readonly failed = new Map<string, string>();
  /**
   * Причина отказа самого сервера на `initialize` (язык → текст ошибки). Наш
   * `failed` говорит «не поднялся», а сервер знает, почему именно: у tsserver это
   * «TypeScript 7 provides no tsserver.js» — без этой строки виноватого не найти.
   */
  private readonly refusals = new Map<string, string>();
  /** Ответ на «лежит ли команда в окружении проекта»: по команде, с проверкой диска. */
  private readonly environmentCommands = new Map<string, boolean>();
  /**
   * Языки, чей проект сервер уже обошёл целиком (см. `scanProject`). Повторный
   * прогрев тех же языков обход НЕ повторяет: сервер прочитал бы проект заново.
   * Сбрасывается перезапуском: у нового процесса индекса нет.
   */
  private readonly scanned = new Set<string>();

  /** Карта символов проекта: второй источник объявлений (см. `SymbolIndexSource`). */
  private indexSource: SymbolIndexSource | null = null;
  /**
   * Приёмник пометок обхода проекта (см. `collectDiagnostics`). Обход и так открывает
   * каждый файл серверу ради символов — пометки приходят тем же окном `didOpen`,
   * и брать их оттуда дешевле, чем открывать файлы второй раз.
   */
  private diagnosticsSink: ((path: string, diagnostics: LspDiagnostic[]) => void) | null = null;

  /**
   * Файлы, открытые серверу ради запроса (`withDocument`) или обхода пометок. Сервер
   * не любит второй `didOpen` одного пути, а обход символов и обход пометок идут
   * вразнобой — оба спрашивают этот набор, прежде чем открывать.
   */
  private readonly transient = new Set<string>();

  /** Языки, чей проект уже обоше́н ради пометок: повторный заход — та же работа. */
  private readonly swept = new Set<string>();

  /** Файлы, которые обход открывал сами и уже закрыл: их пустая публикация — эхо `didClose`. */
  private readonly sweptClosed = new Set<string>();

  /** Кто ждёт пометок по файлу: отпускается первым словом сервера о файле (см. `awaitDiagnostics`). */
  private readonly diagnosticWaiters = new Map<string, Set<() => void>>();

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
    /**
     * Запасные серверы для языка — на случай, когда названный в настройках не
     * поднялся (сломан, без пакетов). Порядок — по приоритету источников
     * (venv → поставка → PATH); пусто — запасных нет.
     */
    private readonly alternates: (language: string) => Promise<LspServerConfig[]> = async () => [],
    /**
     * Куда писать журнал обмена с серверами (включается настройкой `lsp.trace`).
     * Не задано — журнала нет: писать некуда.
     */
    private readonly tracePath: () => string | null = () => null,
    /**
     * Файл-затравка языка: первый подходящий файл проекта и его текст. Открыв его
     * серверу, мы даём серверу за что взяться при обходе проекта (см. `scanProject`).
     * Не задано или null — серверу открывать нечего, обход идёт как раньше.
     */
    private readonly seedDocument: (language: string) => Promise<{ path: string; text: string } | null> = async () =>
      null,
  ) {}

  /**
   * Состояние серверов: какие языки запущены, ЧТО за сервер и откуда он взят, и что
   * поднять не удалось. Без этого «почему тут нет подсказок» ищут наугад — а причина
   * обычно видна сразу: сервер не найден или не ответил на `initialize`.
   */
  status(): LspStatus {
    const servers = [...this.runtimes.values()].map((runtime) => ({
      language: runtime.config.language,
      label: runtime.config.label?.trim() || baseName(runtime.config.command),
      origin: this.originOf(runtime.config),
    }));
    return {
      running: [...this.runtimes.keys()],
      servers,
      failed: [...this.failed.entries()].map(([language, reason]) => ({
        language,
        reason,
      })),
    };
  }

  /**
   * Перезапуск: это же и единственный способ снять «не поднялось». Негативный кэш
   * (`failed`) держим, чтобы не искать заново несуществующий сервер на каждом файле;
   * сбрасывается он здесь — то есть по команде человека или при смене окружения.
   */
  restart(): LspStatus {
    // Подъёмы, начатые до перезапуска, станут ненужными: счётчик версий их отсечёт.
    this.generation += 1;
    this.failed.clear();
    // Причина отказа тоже устарела: следующий подъём может пройти (человек поставил tsserver).
    this.refusals.clear();
    // Новые процессы проекта ещё не читали: при следующем прогреве обойдут заново.
    this.scanned.clear();
    for (const language of [...this.runtimes.keys()]) this.stop(language);
    return this.status();
  }

  /**
   * Поднять серверы заранее, не дожидаясь открытия файла.
   *
   * Обычный путь ленивый: сервер стартует на первом `open` файла своего языка. Но
   * подъём занимает секунды, и всё это время подсказки, переходы и поиск по символам
   * молчат, а чип в статусбаре пуст. Прогрев убирает паузу: проект открыт — серверы
   * его языков начинают подниматься сразу.
   *
   * Берём только языки, для которых сервер ЕСТЬ в настройках: язык без сервера
   * пропускаем молча, не записывая его в `failed`, — иначе чип засорился бы «сервер
   * не найден» у языков, о серверах для которых речи не шло. Мастер-тумблер
   * `lsp.enabled` уважаем так же, как везде. Возврат после подъёма: вызывающий
   * сразу видит итог в `status`.
   *
   * Поднятый сервер сразу получает обход проекта (`scanProject`): без него индекс
   * собирался бы только по запросу — то есть первым поиском символа или ссылок.
   */
  async prewarm(languages: readonly string[]): Promise<void> {
    if (!this.settings().enabled) return;
    const wanted = prewarmLanguages(languages, this.settings().servers);
    // Параллельно: языки независимы, и ждать их по очереди — терять время зря.
    // Повторный прогрев безопасен: уже поднятый сервер отдаётся как есть, а два
    // одновременных вызова одного языка ждут один и тот же подъём (см. `starting`).
    await Promise.all(
      wanted.map(async (language) => {
        const runtime = await this.runtimeFor(language).catch(() => null);
        // Подняли впервые — сразу просим сервер обойти проект: с этого момента индекс
        // готов, и поиск по символам не ждёт первого запроса человека.
        if (runtime) {
          await this.scanProject(runtime);
          // Пометки — сразу после обхода и в фоне: счётчик ошибок и предупреждений
          // в строке состояния должен быть заполнен, пока человек ещё ничего не открыл.
          const root = this.root();
          if (root) void this.sweepDiagnostics(runtime, root).catch(() => undefined);
        }
      }),
    );
  }

  /**
   * Подключить карту символов: её объявления домешиваются к ответу серверов.
   * `null` — карты нет, поиск отвечает только сервером (как раньше).
   */
  attachIndex(source: SymbolIndexSource | null): void {
    this.indexSource = source;
  }

  /**
   * Обход проекта сервером: сервер строит индекс файлов, а не отвечает по одному
   * документу. Зовём `workspace/symbol` с редкой строкой и выбрасываем ответ —
   * нужен не список, а то, что сервер к нему прочитает и разберёт.
   *
   * Без этого шага индекс собирается по требованию: первый поиск символа или ссылок
   * после открытия проекта идёт секундами (а у части серверов на большом проекте —
   * заметно дольше). Прогрев сервера без обхода закрывал только половину паузы.
   *
   * ПЕРЕД обходом серверу открывается файл-затравка (`seedDocument`). Это не
   * украшение, а условие работы: у `tsserver` без единого открытого файла нет ни
   * одного проекта, и `workspace/symbol` отвечает ошибкой «No Project.» — то есть
   * обход не работал ВООБЩЕ, и поиск символов по проекту оставался пустым, пока
   * человек не откроет вкладку. Затравку не закрываем: после `didClose` проект
   * снова теряется и индекс пропадает.
   *
   * Сервер без `workspace/symbol` (pylsp, marksman) обойти проект не умеет —
   * затравки ему хватает: дальше он индексирует сам, по мере надобности.
   * Сбой или таймаут тоже не повод считать сервер сломанным — при первом
   * настоящем запросе индекс дособерётся сам.
   */
  private async scanProject(runtime: ServerRuntime): Promise<void> {
    const language = runtime.config.language;
    if (this.scanned.has(language)) return;
    await runtime.initialized.catch(() => undefined);
    // Отмечаем ДО запросов: два прогрева одного языка, пришедшие разом, не должны
    // запустить два обхода — сервер прочитал бы проект дважды.
    this.scanned.add(language);
    await this.seed(runtime);
    if (!runtime.capabilities.workspaceSymbolProvider) return;
    // Повтор: сервер мог ещё подхватывать затравку, а обход до этого — не знать
    // ни одного проекта. Вторая попытка дешёва: первый запрос уже прогрел кеши.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await withTimeout(
          runtime.connection.request('workspace/symbol', {
            query: PROJECT_SCAN_QUERY,
          }),
          PROJECT_SCAN_TIMEOUT_MS,
          'обход проекта',
        );
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }
  }

  /**
   * Открыть серверу файл языка из проекта, если он ещё ничего не знает. Без этого
   * обход проекта у `tsserver` невозможен (см. `scanProject`), а у остальных серверов
   * он просто начинает индекс раньше. Документ остаётся открытым — иначе сервер
   * теряет проект и вместе с ним индекс.
   */
  private async seed(runtime: ServerRuntime): Promise<void> {
    const seed = await this.seedDocument(runtime.config.language).catch(() => null);
    if (!seed) return;
    // Файл уже открыт в редакторе — сервер проект знает, затравка не нужна.
    if (this.openedIn.has(seed.path)) return;
    await this.open(seed.path, runtime.config.language, seed.text).catch(() => undefined);
  }

  /**
   * Чем сервер готов открывать подсказки: знаки-триггеры, знаки «принять» и умеет ли
   * он доводить элемент отдельным запросом. Renderer берёт это отсюда, чтобы попап
   * появлялся по знакам САМОГО сервера (`@` в CSS, `:` в JSON, `.` в TS), а не только
   * по нашему правилу про точку. Сервера для пути нет — пустой ответ.
   */
  completionTriggers(path: string): {
    triggerCharacters: string[];
    allCommitCharacters: string[];
    resolveProvider: boolean;
  } {
    const provider = this.runtimeForPath(path)?.capabilities.completionProvider;
    return {
      triggerCharacters: provider?.triggerCharacters ?? [],
      allCommitCharacters: provider?.allCommitCharacters ?? [],
      resolveProvider: provider?.resolveProvider ?? false,
    };
  }

  /** Открыть документ в подходящем сервере. Нет сервера для языка — тихо ничего не делаем. */
  async open(path: string, languageId: string, text: string): Promise<void> {
    // Обещание кладём в карту ДО первого `await`: `request` по этому же пути ждёт
    // его и не обгоняет открытие. Снять — в `finally`, чтобы ошибка не заклинила файл.
    const pending = this.doOpen(path, languageId, text).finally(() => {
      if (this.opening.get(path) === pending) this.opening.delete(path);
    });
    this.opening.set(path, pending);
    return pending;
  }

  private async doOpen(path: string, languageId: string, text: string): Promise<void> {
    // Язык и текст помним сразу, до подъёма сервера: правки могут прийти уже сейчас,
    // а `didOpen` уедет только после `initialize`.
    this.languageOfPath.set(path, languageId);
    this.latestText.set(path, text);
    const runtime = await this.runtimeFor(languageId);
    if (!runtime) {
      // Сервера нет — молчим, но язык и текст НЕ забываем: файл открыт в редакторе,
      // и знание о нём нужно следующему `open` (перезапуск сервера) и `change`.
      // Раньше здесь стоял `delete` — один неудачный подъём стирал файл из карты,
      // и правки/запросы уходили в никуда до переоткрытия вкладки.
      return;
    }
    await runtime.initialized.catch(() => undefined);
    // Файл успели закрыть или переоткрыть другим языком — открывать нечего.
    if (this.languageOfPath.get(path) !== languageId) return;
    // Пока сервер поднимался, файл могли править: отдаём АКТУАЛЬНЫЙ текст, а не тот,
    // что был при открытии, — иначе сервер разберёт устаревший код.
    const current = this.latestText.get(path) ?? text;
    // Документ уже открыт этим сервером (его открыл обход проекта, см. `seed`) —
    // второй `didOpen` не нужен, но текст мог смениться: шлём правку.
    if (this.openedIn.get(path) === runtime) {
      this.change(path, current);
      return;
    }
    runtime.versions.set(path, 1);
    this.openedIn.set(path, runtime);
    runtime.connection.notify('textDocument/didOpen', {
      textDocument: {
        uri: pathToFileURL(path).toString(),
        languageId,
        version: 1,
        text: current,
      },
    });
  }

  change(path: string, text: string): void {
    // Помним последний текст даже до появления сервера: если `didOpen` ещё не ушёл,
    // именно этот текст и уедет серверу (см. `open`) — правка не потеряется.
    this.latestText.set(path, text);
    // Прежние токены — про прежний текст: дельта к ним описывала бы правку к
    // тексту, которого больше нет. Следующий запрос пойдёт полным.
    this.semanticCache.delete(path);
    const runtime = this.runtimeForPath(path);
    if (!runtime) return;
    // Сервер ещё не получил `didOpen` — правку отдаст он сам, актуальным текстом.
    if (this.openedIn.get(path) !== runtime) return;
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

  /** Документ сейчас будет записан (`willSave`): сервер успевает подготовиться. */
  willSave(path: string): void {
    const runtime = this.runtimeForPath(path);
    if (!runtime || this.openedIn.get(path) !== runtime) return;
    if (!runtime.capabilities.textDocumentSyncWillSave) return;
    runtime.connection.notify('textDocument/willSave', {
      textDocument: { uri: pathToFileURL(path).toString() },
      reason: 1,
    });
  }

  /**
   * Файл сейчас будет записан, и сервер вправе сказать, что записать вместо
   * этого (`textDocument/willSaveWaitUntil`).
   *
   * Это то, что в VS Code делает format-on-save у языков, где форматирует сам
   * сервер: он видит документ и знает, что поправить. `didSave` без этого — уже
   * поздно, файл на диске.
   *
   * Правки сервер считает по своему тексту, а записываем мы `text`. Поэтому
   * сравниваем: не совпало — правок не берём (см. ниже). Настройки — табы и 4
   * пробела: своих настроек форматирования у нас нет, а сервер берёт их отсюда.
   *
   * Пусто — либо сервер не умеет, либо записывать надо как есть. Различия между
   * этими случаями вызывающему не нужны: и то и другое значит «правок нет».
   */
  async willSaveWaitUntil(path: string, text: string): Promise<TextEdit[]> {
    const runtime = this.runtimeForPath(path);
    if (!runtime || this.openedIn.get(path) !== runtime) return [];
    const capabilities = runtime.capabilities as { textDocumentSyncWillSaveWaitUntil?: boolean };
    if (!capabilities.textDocumentSyncWillSaveWaitUntil) return [];
    // Сервер форматирует свою копию документа, а записываем мы `text`. Если он
    // видел другой текст, его правки встанут не туда — а молча испортить файл при
    // сохранении хуже, чем не отформатировать.
    if (this.latestText.get(path) !== text) return [];
    await runtime.initialized.catch(() => undefined);
    try {
      const result = await runtime.connection.request('textDocument/willSaveWaitUntil', {
        textDocument: { uri: pathToFileURL(path).toString() },
        reason: 1,
        options: { tabSize: 4, insertSpaces: true },
      });
      return toFormatEdits(result);
    } catch {
      // Отказ сервера — не повод не сохранять: пишем то, что получили.
      return [];
    }
  }

  /**
   * Сменился набор корней области — сказать серверу
   * (`workspace/didChangeWorkspaceFolders`). Без этого второй корень для него не
   * существует: поиск символов и переходы ищут только в первом.
   * `added`/`removed` считает вызывающий: серверу нужна разница, а не всё сразу.
   */
  rootsChanged(added: readonly string[], removed: readonly string[]): void {
    if (added.length === 0 && removed.length === 0) return;
    const folder = (root: string) => ({
      uri: pathToFileURL(root).toString(),
      name: path.basename(root) || root,
    });
    for (const runtime of this.runtimes.values()) {
      if (!runtime.capabilities.workspaceFolders) continue;
      runtime.connection.notify('workspace/didChangeWorkspaceFolders', {
        event: { added: added.map(folder), removed: removed.map(folder) },
      });
    }
  }

  /**
   * Документ сохранён на диск — сказать серверу (`didSave`).
   *
   * Сохранить файл можно и мимо редактора (файловый менеджер, `touch`, скрипт), и
   * сервер об этом иначе не узнает: проверки на сохранении там тоже нужны. Такой
   * файл сервер не видел вовсе, а `didSave` про неоткрытый документ протокол
   * запрещает — поэтому открываем его на время сохранения и закрываем сразу.
   * Текст берём с диска: `latestText` у неоткрытого файла пуст, а серверу нужен
   * именно тот текст, что записали.
   */
  saved(path: string, text?: string): void {
    // Язык — и из `languageOfPath`, и по расширению: файл, закрытый в редакторе,
    // уже вычеркнут из первой карты, а сервер, который его проверяет, остался.
    const languageId = this.languageFor(path);
    const runtime = languageId ? (this.runtimes.get(languageId) ?? null) : null;
    if (!runtime) return;
    const save = runtime.capabilities.textDocumentSyncSave;
    if (!save) return;
    const uri = pathToFileURL(path).toString();

    if (this.openedIn.get(path) !== runtime) {
      if (!languageId || text === undefined) return;
      runtime.versions.set(path, 1);
      this.openedIn.set(path, runtime);
      runtime.connection.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
      runtime.connection.notify('textDocument/didSave', {
        textDocument: { uri },
        ...(save.includeText ? { text } : {}),
      });
      runtime.connection.notify('textDocument/didClose', { textDocument: { uri } });
      this.openedIn.delete(path);
      runtime.versions.delete(path);
      return;
    }

    const current = this.latestText.get(path);
    runtime.connection.notify('textDocument/didSave', {
      textDocument: { uri },
      ...(save.includeText && current !== undefined ? { text: current } : {}),
    });
  }

  /**
   * Настройки языковых серверов поменялись (путь к питону, аргументы, окружение).
   *
   * Перезапускать серверы не надо — они берут настройки при `initialize` и потом
   * только по запросу. Но узнать о правке они должны сами: без `didChangeConfiguration`
   * сервер держит старые до перезапуска IDE.
   */
  settingsChanged(): void {
    const python = this.pythonPath();
    for (const runtime of this.runtimes.values()) {
      if (!runtime.capabilities.workspaceConfiguration) continue;
      runtime.connection.notify('workspace/didChangeConfiguration', {
        settings: { python: python ? { pythonPath: python } : {} },
      });
    }
  }

  /**
   * Файл изменился или исчез на диске мимо редактора: `kind` 1 — создан, 2 — изменён,
   * 3 — удалён, `null` — не знаем (переполнение наблюдения, перезапуск): такой путь
   * отдаём как «изменён», потому что создание на сервере посчитали бы дублем.
   */
  watchedFiles(paths: readonly string[], kind: 1 | 2 | 3 | null): void {
    const changes = paths.map((path) => ({ uri: pathToFileURL(path).toString(), type: kind ?? 2 }));
    for (const runtime of this.runtimes.values()) {
      if (runtime.capabilities.workspaceWatchedFiles) {
        runtime.connection.notify('workspace/didChangeWatchedFiles', { changes });
      }
    }
  }

  /**
   * Файл появился, переехал или исчез по нашей вине (проводник, файловые операции).
   *
   * `didChangeWatchedFiles` для этого мало: `fs.watch` не различает переименование, и
   * сервер видит два независимых пути, теряя связь «старое имя → новое». Отдельные
   * `didCreateFiles`/`didRenameFiles`/`didDeleteFiles` эту связь сохраняют — по ним
   * сервер переносит состояние файла, а не гадает.
   */
  fileOperation(kind: 'create' | 'rename' | 'delete', paths: readonly string[], oldPath?: string): void {
    if (paths.length === 0 && !oldPath) return;
    const files = paths.map((path) => ({ uri: pathToFileURL(path).toString() }));
    for (const runtime of this.runtimes.values()) {
      if (!runtime.capabilities.workspaceFileOperations) continue;
      if (kind === 'create') runtime.connection.notify('workspace/didCreateFiles', { files });
      else if (kind === 'delete') runtime.connection.notify('workspace/didDeleteFiles', { files });
      else if (oldPath) {
        runtime.connection.notify('workspace/didRenameFiles', {
          files: [{ oldUri: pathToFileURL(oldPath).toString(), newUri: files[0]?.uri ?? '' }],
        });
      }
    }
  }

  close(path: string): void {
    const runtime = this.runtimeForPath(path);
    this.languageOfPath.delete(path);
    this.latestText.delete(path);
    this.semanticCache.delete(path);
    this.pullState.delete(path);
    if (!runtime) return;
    // `didClose` только если документ и правда был открыт: иначе мы закрыли бы то,
    // чего сервер не видел (открытие ещё шло), и он потерял бы файл.
    const opened = this.openedIn.get(path) === runtime;
    this.openedIn.delete(path);
    runtime.versions.delete(path);
    if (opened) {
      runtime.connection.notify('textDocument/didClose', {
        textDocument: { uri: pathToFileURL(path).toString() },
      });
    }
    this.publish(PushTopic.LspDiagnostics, { path, diagnostics: [] });
  }

  dispose(): void {
    this.generation += 1;
    this.failed.clear();
    this.refusals.clear();
    this.scanned.clear();
    this.latestText.clear();
    this.semanticCache.clear();
    this.pullState.clear();
    this.openedIn.clear();
    for (const language of [...this.runtimes.keys()]) this.stop(language);
  }

  private runtimeForPath(path: string): ServerRuntime | null {
    // Язык узнаём тем же способом, что и запросы (`languageFor`): из карты открытых
    // файлов, а если файла там ещё нет — по расширению. Иначе первый же запрос,
    // пришедший раньше `didOpen`, молча получал `null` и подсказок не было вовсе.
    const language = this.languageFor(path);
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

    // Уже пробовали и не смогли: повторять поиск сервера (диск, PATH) на каждый файл
    // незачем — иначе «почему нет подсказок» станет вечным шумом. Снять можно
    // перезапуском (он же — кнопка в попапе языковых серверов).
    if (this.failed.has(language)) return null;

    const inFlight = this.starting.get(language);
    if (inFlight) return inFlight;

    const pending = this.startLanguage(language).finally(() => this.starting.delete(language));
    this.starting.set(language, pending);
    return pending;
  }

  private async startLanguage(language: string): Promise<ServerRuntime | null> {
    if (!this.settings().enabled) return null;

    const generation = this.generation;
    const tried = new Set<string>();
    const key = (server: LspServerConfig): string => [server.command, ...server.args].join(' ');
    const attempt = async (list: readonly LspServerConfig[]): Promise<ServerRuntime | null> => {
      for (const config of list) {
        if (tried.has(key(config))) continue;
        tried.add(key(config));
        const runtime = await this.tryStart(config, generation);
        if (runtime) return runtime;
      }
      return null;
    };
    // Сперва — названное в настройках. Альтернативы ищем только если оно не поднялось:
    // их поиск недёшев (диск, PATH), а обычный случай — как раз первый сервер.
    const configured = serverCandidates(this.settings().servers, [], language);
    const chosen = await attempt(configured);
    if (chosen) {
      this.failed.delete(language);
      return chosen;
    }
    const alternates = serverCandidates([], await this.alternates(language), language);
    const fallback = await attempt(alternates);
    if (fallback) {
      this.failed.delete(language);
      return fallback;
    }
    // Ничего не вышло — запоминаем причину, чтобы человек видел её, а не искал наугад.
    // Сервер, который отказал на `initialize`, называет причину сам («TypeScript 7
    // provides no tsserver.js»): она точнее нашего «не поднялся» и сразу указывает
    // на виновника, поэтому идёт первой.
    const refusal = this.refusals.get(language);
    this.failed.set(
      language,
      refusal ?? (configured.length === 0 && alternates.length === 0 ? 'сервер не найден' : 'сервер не поднялся'),
    );
    return null;
  }

  /**
   * Поднять сервер и дождаться `initialize`. Не поднявшийся процесс не оставляем
   * жить вне учёта, а отдаём `null`: цепочка попробует следующего кандидата. Без
   * этого сломанный сервер (или молчащий на `initialize`) оставил бы язык без
   * подсказок, хотя рабочий сервер в системе есть.
   */
  private async tryStart(config: LspServerConfig, generation: number): Promise<ServerRuntime | null> {
    let runtime: ServerRuntime;
    try {
      runtime = await this.start(config);
    } catch {
      return null; // сервера нет в PATH — это не повод падать IDE
    }
    try {
      await runtime.initialized;
    } catch {
      this.kill(runtime); // не ответил на initialize (ошибка/таймаут) — пробуем дальше
      return null;
    }
    return this.adopt(runtime, generation);
  }

  /** Поставить поднявшийся сервер на учёт — или убить, если его успели перезапустить. */
  private adopt(runtime: ServerRuntime, generation: number): ServerRuntime | null {
    // Пока поднимались, могли перезапустить серверы: тогда этот уже не нужен, и
    // его процесс надо убить — иначе он остался бы жить вне учёта.
    if (generation !== this.generation) {
      this.kill(runtime);
      return null;
    }
    this.runtimes.set(runtime.config.language, runtime);
    return runtime;
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
    // Своё окружение конфига идёт последним: серверам из поставки нужен режим Node
    // (`ELECTRON_RUN_AS_NODE`), и проектное `.env` его перебивать не должно.
    const env = {
      ...mergeEnv(process.env, await this.env()),
      ...(config.env ?? {}),
    };
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
      // Журнал обмена: пишем только когда человек включил трассировку. Проверку делаем
      // на каждом сообщении — тумблер можно переключить и посреди работы.
      (direction, message) => this.trace(direction, message),
    );

    // Сервер упал или завершился — забываем про него, при следующем файле поднимем снова.
    // Причину не теряем: иначе упавший посреди работы сервер исчезал из `status()` молча,
    // и человек видел «чип пропал и подсказок нет» без единого слова почему.
    const forget = (code: number | null, signal: string | null): void => {
      connection.dispose();
      const current = this.runtimes.get(config.language);
      if (current?.connection !== connection) return;
      this.runtimes.delete(config.language);
      this.failed.set(config.language, exitReason(code, signal));
      this.publish(PushTopic.LspServers, this.status());
    };
    child.on('exit', forget);
    child.on('error', (error) => {
      forget(null, String(error?.message ?? error));
    });

    const runtime: ServerRuntime = {
      config,
      child,
      connection,
      versions: new Map(),
      capabilities: {},
      positionEncoding: 'utf-16',
      initialized: Promise.resolve(),
    };
    // Инициализацию не ждём синхронно: didOpen уедет после неё (см. open()).
    (runtime as { initialized: Promise<void> }).initialized = this.initialize(runtime, cwd);
    return runtime;
  }

  private async initialize(runtime: ServerRuntime, cwd: string): Promise<void> {
    const python = this.pythonPath();
    const rootUri = pathToFileURL(cwd).toString();
    const result = (await withTimeout(
      runtime.connection.request('initialize', {
        processId: process.pid,
        // Корень проекта называем ТРЕМЯ способами, и это не избыточность: разные
        // серверы слушают разное поле. `workspaceFolders` — современный способ, но
        // его игнорируют серверы постарше; `rootUri` и `rootPath` — старые, но их
        // игнорирует Pyright (без них он считает корнем `/<default workspace root>`
        // и не разрешает импорты вида `tests.v2.page`, оставляя подсказки пустыми).
        rootUri,
        rootPath: cwd,
        workspaceFolders: [{ uri: rootUri, name: path.basename(cwd) }],
        clientInfo: { name: 'chui_iDE' },
        // Возможности клиента — это РАЗРЕШЕНИЕ серверу отдать больше. Чего здесь нет,
        // того сервер прислать не вправе: без `documentationFormat` не будет описаний,
        // без `tagSupport` — пометки «устарело», без `snippetSupport` — заготовок.
        // Поэтому список полный — но ровно из того, что мы умеем показать: объявлять
        // `resolveSupport` и при этом не звать `completionItem/resolve` значило бы
        // попросить сервер прислать голый `label` — то самое «пусто после точки».
        capabilities: {
          textDocument: {
            synchronization: {},
            completion: {
              completionItem: {
                // Заготовки: разметку `${1:…}` раскрывает наш редактор (expandSnippet).
                snippetSupport: true,
                // Знаки «принять» от сервера (Enter, Tab, у части серверов — `.`).
                commitCharactersSupport: true,
                documentationFormat: ['markdown', 'plaintext'],
                deprecatedSupport: true,
                preselectSupport: true,
                // Пометка «устарело» в новой форме (`tags: [Deprecated]`).
                tagSupport: { valueSet: [1] },
                insertReplaceSupport: true,
                labelDetailsSupport: true,
                // Объявляем ТОЛЬКО то, что действительно доводим: список зовёт
                // `completionItem/resolve` и берёт оттуда `documentation` и `detail`.
                // `additionalTextEdits` тут НАМЕРЕННО нет: авто-импорт мы применяем
                // из первого ответа, а заявив его здесь, потеряли бы его у тех
                // серверов, что перенесли правки в resolve.
                resolveSupport: { properties: ['documentation', 'detail'] },
              },
            },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            signatureHelp: {
              signatureInformation: {
                documentationFormat: ['markdown', 'plaintext'],
                parameterInformation: { labelOffsetSupport: true },
              },
            },
            definition: { linkSupport: true },
            // Диагностика — по этому ключу серверы решают, слать ли `publishDiagnostics`
            // вообще: `typescript-language-server` v6 читает его как `diagnosticsSupport`
            // и без объявления молчит совсем — ни пометок открытого файла, ни обхода
            // проекта. Объявляем то, что умеем: `version` отбрасываем, если он старше
            // нашей правки (см. обработчик `publishDiagnostics`).
            publishDiagnostics: { versionSupport: true },
            // Диагностика по запросу. Объявляем, чтобы сервер, умеющий
            // `textDocument/diagnostic`, мог ответить о файле, которого не открывал.
            // `relatedInformation` — не нужен от клиента, поэтому не заявляем.
            diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
            // Дерево символов файла: у объявления появляются дети — так и показываем.
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            rename: { prepareSupport: true },
            foldingRange: { lineFoldingOnly: true },
            // Выделение по структуре: сервер отдаёт цепочку участков вокруг места —
            // слово, выражение, строка, блок (см. `LspFeatures.selectionRanges`).
            selectionRange: {},
            codeLens: { dynamicRegistration: false },
            codeAction: {
              isPreferredSupport: true,
              codeActionLiteralSupport: {
                codeActionKind: {
                  valueSet: [
                    '',
                    'quickfix',
                    'refactor',
                    'refactor.extract',
                    'refactor.inline',
                    'refactor.rewrite',
                    'source',
                    'source.organizeImports',
                    'source.fixAll',
                  ],
                },
              },
            },
            callHierarchy: {},
            // Иерархия типов: надтипы и подтипы (команды «Иерархия типов» в палитре).
            typeHierarchy: {},
            // Ссылки в коде: подчёркнутые кликабельные участки (пути в import, адреса).
            // tooltipSupport — сервер вправе дать подпись наведения к ссылке.
            documentLink: { tooltipSupport: true },
            // Связанные участки: имена парных тегов правятся вместе (открывающий и
            // закрывающий тег). Правим все участки сразу — своей правкой на каждый.
            linkedEditingRange: {},
            // Моникеры: устойчивое имя символа — связать его с тем же символом в других
            // инструментах. Показываем по команде (см. `LspFeatures.monikers`).
            moniker: {},
            // Значения переменных в коде при отладке: сервер помечает участки, а значения
            // берём у отладчика (см. `LspFeatures.inlineValues`). Объявляем без динамической
            // регистрации — её мы не поддерживаем.
            inlineValue: {},
            // Семантическая подсветка: точные роли поверх своей грамматики. Объявляем и
            // `range`: большой файл не нужно разбирать целиком ради экрана (см.
            // `semanticTokens`). Типы и модификаторы объявляем стандартные: сервер вернёт
            // их индексами в легенде, а мы сопоставим с ролями палитры.
            semanticTokens: {
              requests: { full: true, range: true },
              tokenTypes: [...STANDARD_TOKEN_TYPES],
              tokenModifiers: [...STANDARD_TOKEN_MODIFIERS],
            },
          },
          window: {
            // Сервер вправе сообщать, чем занят, и просить создать свой индикатор: без
            // этой возможности долгая индексация шла бы «молча» (см. `$/progress`).
            workDoneProgress: true,
          },
          workspace: {
            // Серверы (pylsp, pyright) спрашивают настройки этим запросом.
            configuration: true,
            workspaceFolders: true,
            // Файлы поменялись мимо редактора: без этого объявления сервер не ждёт
            // `didChangeWatchedFiles`, и наш отказ (`workspaceWatchedFiles` выше) всегда ложен.
            didChangeWatchedFiles: { dynamicRegistration: false },
            symbol: {},
            // Правки сервера (переименование) приходят с `documentChanges` — разбираем.
            // Заодно умеем операции с файлами: создать, переименовать, удалить (их применяет
            // приложение). Без этого объявления сервер их не пришлёт (см. capabilities).
            workspaceEdit: {
              documentChanges: true,
              resourceOperations: ['create', 'rename', 'delete'],
            },
            // Операции с файлами, сделанные руками (проводник, терминал, `mv`):
            // без объявления сервер не ждёт `didCreateFiles` и родни, и новый модуль
            // остаётся невидимым, пока сервер не перезапустят.
            fileOperations: {
              didCreate: { filters: [UNFILTERED_FILE_OPERATION] },
              didRename: { filters: [UNFILTERED_FILE_OPERATION] },
              didDelete: { filters: [UNFILTERED_FILE_OPERATION] },
            },
          },
        },
        // Путь к питону передаём сразу: pyright берёт его отсюда, иначе не видит
        // пакеты окружения и подсказки по импортам не поднимаются. Свои доводы
        // сервера (например, путь к `tsserver.js`) идут следом и дополняют их.
        // Кодировка позиций: протокол по умолчанию — utf-16 (наш нативный).
        // Объявляем ОБЕ: если сервер требует utf-32 (русский текст плюс эмодзи
        // иначе сдвигает его подсказки), он выберет его сам и ответит одним из
        // списка; смотреть ответ будем ниже (`negotiateEncoding`).
        general: { positionEncodings: ['utf-16', 'utf-32'] },
        initializationOptions: buildInitializationOptions(runtime, python),
      }),
      INITIALIZE_TIMEOUT_MS,
      `initialize: ${runtime.config.command}`,
    )) as {
      capabilities?: LspCapabilities;
      error?: { message?: string };
    } | null;

    // Отказ самого сервера (`initialize` ответил `error`) — причина точнее нашей:
    // она называет виновника, например «TypeScript 7 provides no tsserver.js».
    const refusal = result?.error?.message;
    if (refusal) this.refusals.set(runtime.config.language, refusal);

    // Возможности решают, что можно спрашивать: их отсутствие — не ошибка.
    runtime.capabilities = withSyncCapabilities(result?.capabilities);
    // Кодировку берём из ОТВЕТА сервера: он мог потребовать utf-32, и тогда все
    // колонки придётся пересчитывать (см. `position-encoding.ts`). Ответ без поля —
    // стандартный utf-16.
    runtime.positionEncoding = negotiateEncoding(result?.capabilities?.positionEncoding);
    runtime.connection.notify('initialized', {});
    // Трассировка — уведомление КЛИЕНТА серверу: включаем, если человек просил.
    if (this.settings().trace) runtime.connection.notify('$/setTrace', { value: 'verbose' });
  }

  /**
   * Записать сообщение обмена в журнал — если трассировка включена и файл есть.
   * Пишем построчно (`JSON.stringify`), дописываем в конец: журнал читается хвостом.
   */
  private trace(direction: 'client' | 'server', message: unknown): void {
    if (!this.settings().trace) return;
    const file = this.tracePath();
    if (!file) return;
    const line = `${JSON.stringify({ at: new Date().toISOString(), direction, message })}\n`;
    // Пишем не дожидаясь: журнал не должен задерживать сам обмен.
    void appendFile(file, line, 'utf8').catch(() => undefined);
  }

  /**
   * Запрос к серверу по уже открытому документу: подсказки, наведение, переход.
   * Ошибка или отсутствие сервера — это `null`, а не сбой: без подсказок
   * редактор обязан работать дальше.
   */
  async request(path: string, method: string, params: unknown): Promise<unknown> {
    const language = this.languageFor(path);
    if (!language) return null;
    // Ждём открытия этого файла, если оно ещё в пути: иначе запрос уходит вперёд
    // `didOpen`, и сервер ищет по документу, которого не знает — ответ пустой.
    await this.opening.get(path)?.catch(() => undefined);
    // Сервер поднимаем тут же, если его ещё нет: `open` и запрос идут от renderer
    // разными запросами, и порядок между ними не гарантирован.
    const runtime = await this.runtimeFor(language);
    if (!runtime) return null;
    await runtime.initialized.catch(() => undefined);
    // Ключ отмены — «этот файл, этот вид запроса»: свежий вытесняет устаревший.
    const cancelKey = CANCELLABLE_METHODS.has(method) ? `${path}\u0000${method}` : undefined;
    try {
      return await runtime.connection.request(method, params, cancelKey);
    } catch {
      return null;
    }
  }

  /**
   * Отформатировать участок (`textDocument/rangeFormatting`). Пустой ответ — сервер
   * не умеет или менять нечего; для вызывающего это одно и то же. Форматирует именно
   * УЧАСТОК, а не файл целиком: этим и отличается от инструмента проекта (ruff, prettier),
   * который всегда переписывает файл.
   */
  async formatRange(
    path: string,
    range: {
      startLine: number;
      startColumn: number;
      endLine: number;
      endColumn: number;
    },
  ): Promise<TextEdit[]> {
    const runtime = this.runtimeForPath(path);
    if (!runtime?.capabilities.documentRangeFormattingProvider) return [];
    await runtime.initialized.catch(() => undefined);
    const uri = pathToFileURL(path).toString();
    try {
      const result = await runtime.connection.request('textDocument/rangeFormatting', {
        textDocument: { uri },
        // Текст сюда не приходит (только границы), поэтому пересчёт колонок для
        // utf-32 серверов недоступен: шлём UTF-16-колонки как есть. Форматирование
        // блока с эмодзи у utf-32-сервера может съехать — редкий путь, отмечено в TASKS.
        range: {
          start: {
            line: Math.max(0, range.startLine - 1),
            character: Math.max(0, range.startColumn - 1),
          },
          end: {
            line: Math.max(0, range.endLine - 1),
            character: Math.max(0, range.endColumn - 1),
          },
        },
        options: { tabSize: 4, insertSpaces: true },
      });
      return toFormatEdits(result);
    } catch {
      return [];
    }
  }

  async formatDocument(path: string): Promise<TextEdit[]> {
    const runtime = this.runtimeForPath(path);
    if (!runtime?.capabilities.documentFormattingProvider) return [];
    await runtime.initialized.catch(() => undefined);
    try {
      const result = await runtime.connection.request('textDocument/formatting', {
        textDocument: { uri: pathToFileURL(path).toString() },
        options: { tabSize: 4, insertSpaces: true },
      });
      return toFormatEdits(result);
    } catch {
      return [];
    }
  }

  /**
   * Форматирование нескольких кусков разом (rangesFormatting). Шлём один запрос
   * вместо пачки `rangeFormatting`: сервер видит куски вместе и не разъезжается
   * на стыках.
   */
  async formatRanges(
    path: string,
    ranges: ReadonlyArray<{ start: { line: number; character: number }; end: { line: number; character: number } }>,
  ): Promise<TextEdit[]> {
    const runtime = this.runtimeForPath(path);
    if (!runtime) return [];
    await runtime.initialized.catch(() => undefined);
    const provider = runtime.capabilities.documentRangeFormattingProvider;
    if (!provider || ranges.length === 0) return [];
    try {
      const result = await runtime.connection.request('textDocument/rangesFormatting', {
        textDocument: { uri: pathToFileURL(path).toString() },
        ranges,
        options: { tabSize: 2, insertSpaces: true },
      });
      return toFormatEdits(result);
    } catch {
      return [];
    }
  }

  /**
   * Семантическая подсветка файла: точные роли от сервера поверх нашей грамматики.
   * Ответ сервер шлёт числами-сдвигами, а тип — индексом в СВОЕЙ легенде, поэтому
   * разбираем здесь, где легенда под рукой: renderer получает готовые участки.
   * Сервера нет, легенды нет или ответ пуст — пустой список: подсветка останется своя.
   */
  /**
   * Семантические токены файла или его участка.
   *
   * `range` — 0-based строки участка. Серверу, умеющему `semanticTokens/range`,
   * отдаём его: большой файл не нужно разбирать целиком ради экрана. Умеющему
   * только `full` — спрашиваем файл целиком и режем сами: подсветка вне экрана
   * ещё пригодится при прокрутке, а лишний разговор с сервером — нет.
   */
  async semanticTokens(
    path: string,
    languageId?: string,
    range?: { startLine: number; endLine: number },
  ): Promise<SemanticToken[]> {
    // Язык берём у вызывающего, а не только из `languageOfPath`: туда пишет
    // `open`, а он у renderer'а уходит `void`-запросом (см. `LspClient.sendOpen`),
    // и его приход не гарантирован раньше этого вызова. Без языка `runtimeForPath`
    // не находил сервер и отдавал пусто — подсветка молча пропадала. Так же
    // устроен `outline`: язык — аргумент, карта — запасной путь.
    const runtime = languageId ? await this.runtimeForDocument(path, languageId) : this.runtimeForPath(path);
    if (!runtime) return [];
    await runtime.initialized.catch(() => undefined);
    const legend = semanticLegend(runtime.capabilities.semanticTokensProvider);
    if (!legend) return [];
    const provider = runtime.capabilities.semanticTokensProvider as
      | { range?: boolean | Record<string, unknown> }
      | undefined;
    const useRange = range !== undefined && provider?.range !== undefined && provider.range !== false;
    try {
      if (useRange) {
        const result = await runtime.connection.request(
          'textDocument/semanticTokens/range',
          {
            textDocument: { uri: pathToFileURL(path).toString() },
            range: {
              start: { line: range.startLine, character: 0 },
              end: { line: range.endLine, character: 0 },
            },
          },
          `${path}\u0000textDocument/semanticTokens/range`,
        );
        return decodeSemanticTokens(result, legend);
      }
      const data = await this.semanticData(path, runtime, provider);
      const tokens = decodeSemanticTokens({ data }, legend);
      if (!range) return tokens;
      return tokens.filter((token) => token.line >= range.startLine && token.line <= range.endLine);
    } catch {
      return [];
    }
  }

  /**
   * Числа токенов файла: `full` в первый раз, дальше `full/delta`, если сервер умеет.
   *
   * Правка на символ перекрашивала весь файл: сервер переразбирал его и присылал
   * полный набор. С `delta` он присылает только изменившиеся пятёрки, а прежние
   * мы храним здесь — по пути и по `resultId`, который сервер попросил прислать
   * в следующий раз. Смена документа `resultId` обнуляет: сервер сам скажет, если
   * кэш не годится, и тогда ответ придёт полный.
   */
  private async semanticData(path: string, runtime: ServerRuntime, provider: unknown): Promise<number[]> {
    const previous = this.semanticCache.get(path);
    const delta = (provider as { full?: { delta?: unknown } } | undefined)?.full?.delta;
    const uri = pathToFileURL(path).toString();
    if (previous && delta) {
      const result = (await runtime.connection.request(
        'textDocument/semanticTokens/full/delta',
        { textDocument: { uri }, previousResultId: previous.resultId },
        `${path}\u0000textDocument/semanticTokens/full/delta`,
      )) as SemanticDelta | null;
      const next = result ? applySemanticDelta(previous.data, result) : null;
      if (next) {
        this.semanticCache.set(path, { resultId: result?.resultId ?? previous.resultId, data: next });
        return next;
      }
      // Не сошлось — просим полный набор ниже: показать подсветку не по тем
      // местам хуже, чем заплатить одним полным ответом.
    }

    const result = (await runtime.connection.request(
      'textDocument/semanticTokens/full',
      { textDocument: { uri } },
      `${path}\u0000textDocument/semanticTokens/full`,
    )) as { data?: number[]; resultId?: string } | null;
    const data = Array.isArray(result?.data) ? result.data : [];
    this.semanticCache.set(path, { resultId: result?.resultId ?? '', data });
    return data;
  }

  /**
   * Символы проекта по запросу: классы, функции, переменные — по всем запущенным
   * серверам. Поиск не привязан к файлу, поэтому спрашиваем каждый сервер, у
   * которого это умеется: ответит тот, чей язык есть в проекте.
   *
   * Ждать сервер вечно нельзя, если ответ уже есть. Пока сервер поднимается, ответа
   * нет секундами, а карта символов его уже знает — тогда отдаём её сразу, а ответ
   * сервера дождётся следующего нажатия клавиши (поиск переспрашивает на каждой букве).
   * Если карта пуста — ждём сервер как раньше: лучче подождать, чем ничего не найти.
   */
  async projectSymbols(query: string): Promise<ProjectSymbol[]> {
    const indexed = this.indexSource?.find(query) ?? [];
    const fromServers = this.serverSymbols(query);
    const results =
      indexed.length > 0
        ? await withTimeout(fromServers, INDEX_FIRST_WAIT_MS, 'поиск символов').catch(() => [] as ProjectSymbol[])
        : await fromServers;

    return mergeSymbols(results, indexed);
  }

  /** Символы без локации: доспросить через `workspaceSymbol/resolve`. */
  private async resolveSymbols(runtime: ServerRuntime, raw: unknown): Promise<ProjectSymbol[]> {
    if (!Array.isArray(raw)) return [];
    // Символ без `location` — незаконченный: сервер просит доспросить его по id.
    const pending = raw.filter((item) => isUnresolvedSymbol(item));
    if (pending.length === 0) return toProjectSymbols(raw, fileURLToPath);
    const resolved = await Promise.all(
      pending.map((item) => runtime.connection.request('workspaceSymbol/resolve', item).catch(() => item)),
    );
    // Собираем ответ обратно: `resolve` возвращает те же объекты с дополненной `location`,
    // а `toProjectSymbols` уже отбросит те, где локации так и не появилось.
    const queue = [...resolved];
    const filled = raw.map((item) => (isUnresolvedSymbol(item) ? (queue.shift() ?? item) : item));
    return toProjectSymbols(filled, fileURLToPath);
  }

  /** Символы от всех поднятых серверов, умеющих искать по проекту. */
  private async serverSymbols(query: string): Promise<ProjectSymbol[]> {
    const results: ProjectSymbol[] = [];

    for (const runtime of [...this.runtimes.values()]) {
      if (!runtime.capabilities.workspaceSymbolProvider) continue;
      await runtime.initialized.catch(() => undefined);
      try {
        const raw = await runtime.connection.request('workspace/symbol', {
          query,
        });
        results.push(...(await this.resolveSymbols(runtime, raw)));
      } catch {
        // Сервер не ответил — это не повод терять результаты остальных.
      }
    }

    return results;
  }

  /**
   * Скелет файла: объявления с номерами строк, без тел. Файл может быть и не
   * открыт в редакторе — тогда открываем его серверу сами и закрываем после
   * ответа: агенту скелет нужен ровно для того, чтобы не читать файл целиком,
   * и ждать, пока человек откроет вкладку, он не может.
   *
   * Текст приходит снаружи: файловой системы у сервиса нет, её читает тот, кто
   * спросил (у агента это `WorkspaceService` — с проверкой путей).
   */
  async outline(path: string, languageId: string, text: string): Promise<FileSymbol[] | null> {
    const runtime = await this.runtimeForDocument(path, languageId);
    // `null` — сервера нет, он этого не умеет или не ответил. Пустой список — другое:
    // сервер ответил, объявлений в файле просто нет. Разница видна агенту в тексте.
    if (!runtime?.capabilities.documentSymbolProvider) return null;

    return this.withDocument(runtime, path, languageId, text, (uri) =>
      runtime.connection
        .request('textDocument/documentSymbol', { textDocument: { uri } })
        .then(toFileSymbols)
        // Сервер не ответил — отдаём `null`, а НЕ пустой список. Разница
        // смысловая: `[]` значит «сервер посмотрел и объявлений нет» (пустой файл,
        // не тот язык), а отказ — «я не могу сказать». Раньше оба случая
        // сваливались в `[]`, и агент читал «объявлений нет» там, где сервер упал
        // или не поднял проект. Шаг из-за этого не ломаем — ответ готовит вызывающий.
        .catch(() => null as FileSymbol[] | null),
    );
  }

  /**
   * Пометки файла по запросу (`textDocument/diagnostic`), а не по публикации.
   *
   * `publishDiagnostics` серверы шлют сами и только про открытые документы:
   * файл, который правят редко, проверяется в лучшем случае «когда-нибудь».
   * Сервер, объявивший `diagnosticProvider`, так делать не обязан, и его можно
   * спросить.
   *
   * Возвращаем `null`, если сервер так не умеет: пустой список стёр бы пометки,
   * а вызывающему остаётся публикация.
   */
  async diagnosticsFor(path: string, text?: string): Promise<LspDiagnostic[] | null> {
    const languageId = this.languageFor(path);
    if (!languageId) return null;
    const runtime = this.runtimes.get(languageId);
    if (!runtime?.capabilities.diagnosticProvider) return null;
    const previous = this.pullState.get(path);

    try {
      const report = await this.withDocument(
        runtime,
        path,
        languageId,
        text ?? this.latestText.get(path) ?? '',
        (uri) =>
          runtime.connection.request(
            'textDocument/diagnostic',
            { textDocument: { uri }, ...(previous ? { previousResultId: previous.resultId } : {}) },
            `${path}\u0000textDocument/diagnostic`,
          ),
      );
      return this.applyDiagnosticReport(path, report);
    } catch (error) {
      // Не молчим: обход проекта по этой ветке вернётся к `didOpen`, но причину
      // надо видеть, а не искать по ответам.
      console.warn('pull-диагностика не вышла:', error);
      return null;
    }
  }

  /**
   * Разобрать ответ `textDocument/diagnostic`: `full` или `unchanged`.
   *
   * `unchanged` означает «с прошлого раза не поменялось», и без запоминания
   * прошлого ответа пометки пришлось бы терять.
   */
  private applyDiagnosticReport(path: string, report: unknown): LspDiagnostic[] {
    const value = (report ?? {}) as {
      kind?: unknown;
      resultId?: unknown;
      items?: unknown;
      relatedDocuments?: unknown;
    };
    const resultId = typeof value.resultId === 'string' ? value.resultId : '';
    if (value.kind === 'unchanged') {
      const previous = this.pullState.get(path);
      if (!previous) return [];
      this.pullState.set(path, { resultId, items: previous.items });
      return previous.items;
    }
    const items = Array.isArray(value.items) ? toDiagnostics(value.items) : [];
    this.pullState.set(path, { resultId, items });
    // `relatedDocuments` — пометки про ДРУГИЕ файлы, от которых пришла ошибка.
    // Отдаём обычной публикацией: в редакторе это те же пометки.
    if (value.relatedDocuments && typeof value.relatedDocuments === 'object') {
      for (const [uri, document] of Object.entries(value.relatedDocuments as Record<string, unknown>)) {
        const doc = document as { kind?: unknown; items?: unknown } | null;
        if (doc?.kind !== 'full' || !Array.isArray(doc.items)) continue;
        this.publish(PushTopic.LspDiagnostics, { path: fileURLToPath(uri), diagnostics: toDiagnostics(doc.items) });
      }
    }
    return items;
  }

  /**
   * Серые подсказки вперёд (`textDocument/inlineCompletion`): продолжение строки,
   * которое редактор показывает бледным и принимает Tab. Своих таких у нас нет —
   * спрашиваем сервер и только если он это умеет.
   */
  async inlineCompletions(
    path: string,
    languageId: string,
    text: string,
    line: number,
    column: number,
  ): Promise<string[]> {
    const runtime = await this.runtimeForDocument(path, languageId);
    if (!runtime?.capabilities.inlineCompletionProvider) return [];

    const answer = await this.withDocument(runtime, path, languageId, text, (uri) =>
      runtime.connection
        .request('textDocument/inlineCompletion', {
          textDocument: { uri },
          position: positionOf(runtime, text, line, column),
          context: { triggerKind: 2 },
        })
        .catch(() => null),
    );
    return toInlineSnippets(answer);
  }

  /**
   * Ссылки на символ: где он ещё встречается. Позиция — объявление символа
   * (её даёт `workspace/symbol`). `includeDeclaration` — включать ли в ответ само
   * объявление: агенту оно обычно уже известно, и он просит только использования.
   *
   * Как и у скелета, файл открываем сами, если он не открыт в редакторе: агенту
   * он нужен сейчас, а не когда человек откроет вкладку.
   */
  async references(
    path: string,
    languageId: string,
    text: string,
    line: number,
    column: number,
    includeDeclaration: boolean,
  ): Promise<SymbolLocation[] | null> {
    const runtime = await this.runtimeForDocument(path, languageId);
    if (!runtime?.capabilities.referencesProvider) return null;

    return this.withDocument(runtime, path, languageId, text, (uri) =>
      runtime.connection
        .request(
          'textDocument/references',
          {
            textDocument: { uri },
            position: positionOf(runtime, text, line, column),
            context: { includeDeclaration },
          },
          `references-${path}`,
          // Ссылок бывает много: просим сервер отдавать их кусками — так первые места
          // видны, не дожидаясь конца поиска (см. `JsonRpcConnection.request`).
          { partial: true },
        )
        .then((raw) => toLocations(raw, fileURLToPath))
        // Как у скелета: не ответил — `null`, а не пусто. `[]` значило бы «искал,
        // не нашёл», и агент сделал бы из этого вывод об устаревании символа.
        .catch(() => null as SymbolLocation[] | null),
    );
  }

  /** Переход к объявлению (`textDocument/declaration`): интерфейс, а не реализация. */
  declaration(path: string, languageId: string, text: string, line: number, column: number) {
    return this.relatedAt(path, languageId, text, line, column, 'textDocument/declaration', 'declarationProvider');
  }

  /** Переход к типу (`textDocument/typeDefinition`): от переменной к её типу. */
  typeDefinition(path: string, languageId: string, text: string, line: number, column: number) {
    return this.relatedAt(
      path,
      languageId,
      text,
      line,
      column,
      'textDocument/typeDefinition',
      'typeDefinitionProvider',
    );
  }

  /** Переход к реализациям (`textDocument/implementation`): от интерфейса — ко всем реализующим. */
  implementations(path: string, languageId: string, text: string, line: number, column: number) {
    return this.relatedAt(
      path,
      languageId,
      text,
      line,
      column,
      'textDocument/implementation',
      'implementationProvider',
    );
  }

  /** Общий путь трёх родственных запросов: перевести позицию и разобрать locations. */
  private async relatedAt(
    path: string,
    languageId: string,
    text: string,
    line: number,
    column: number,
    method: string,
    provider: unknown,
  ): Promise<SymbolLocation[] | null> {
    const runtime = await this.runtimeForDocument(path, languageId);
    if (!runtime || !provider) return null;
    return this.withDocument(runtime, path, languageId, text, (uri) =>
      runtime.connection
        .request(method, {
          textDocument: { uri },
          position: positionOf(runtime, text, line, column),
        })
        .then((raw) => toLocations(raw, fileURLToPath))
        .catch(() => null as SymbolLocation[] | null),
    );
  }

  /** Переход к определению из позиции использования: где символ объявлен. */
  async definition(
    path: string,
    languageId: string,
    text: string,
    line: number,
    column: number,
  ): Promise<SymbolLocation[] | null> {
    const runtime = await this.runtimeForDocument(path, languageId);
    if (!runtime?.capabilities.definitionProvider) return null;

    return this.withDocument(runtime, path, languageId, text, (uri) =>
      runtime.connection
        .request('textDocument/definition', {
          textDocument: { uri },
          position: positionOf(runtime, text, line, column),
        })
        .then((raw) => toLocations(raw, fileURLToPath))
        // Не ответил — `null`, не пусто: «определение не найдено» и «спросить негде»
        // — разные ответы, и второй не должен притворяться первым.
        .catch(() => null as SymbolLocation[] | null),
    );
  }

  /**
   * Переименование символа с учётом семантики: сервер возвращает правки во всех
   * местах, где символ используется, — включая другие файлы. Это и отличает его
   * от текстовой замены `file` (action replace): та бьёт по подстроке и не знает
   * границ символа.
   *
   * Правки возвращаем уже в нашей форме (`FileEdit[]`) — их применяет документная
   * модель renderer, тем же путём, что и правка по позициям. `null` — сервер не умеет
   * переименование.
   */
  // prepareRename: спросить сервер, можно ли переименовать в этой точке.
  async prepareRename(
    path: string,
    languageId: string,
    text: string,
    line: number,
    column: number,
  ): Promise<{ word: string; message: string | null } | null> {
    const runtime = await this.runtimeForDocument(path, languageId);
    if (!runtime?.capabilities.renameProvider) return null;
    const position = positionOf(runtime, text, line, column);
    return this.withDocument(runtime, path, languageId, text, (uri) =>
      runtime.connection
        .request('textDocument/prepareRename', { textDocument: { uri }, position })
        .then((raw) => toPrepareRename(raw))
        .catch(() => null),
    );
  }
  async rename(
    path: string,
    languageId: string,
    text: string,
    line: number,
    column: number,
    newName: string,
  ): Promise<FileEdit[] | null> {
    const runtime = await this.runtimeForDocument(path, languageId);
    if (!runtime?.capabilities.renameProvider) return null;

    return this.withDocument(runtime, path, languageId, text, (uri) =>
      runtime.connection
        .request('textDocument/rename', {
          textDocument: { uri },
          position: positionOf(runtime, text, line, column),
          newName,
        })
        .then((raw) => toWorkspaceFileEdits(raw, fileURLToPath))
        .catch(() => null),
    );
  }

  /** Сервер для файла: уже открытый в редакторе или поднятый по языку. */
  private async runtimeForDocument(path: string, languageId: string): Promise<ServerRuntime | null> {
    return this.runtimeForPath(path) ?? (await this.runtimeFor(languageId));
  }

  /**
   * Откуда взят сервер — по виду его конфига. Точнее не скажешь: к сервису список
   * приходит уже сведённым, и «исходный источник» в нём не сохраняется. Признаки
   * надёжны ровно настолько, насколько задаёт их тот, кто сервер собрал:
   *   • `ELECTRON_RUN_AS_NODE` ставит только поставка (`main/lsp/bundled.ts`);
   *   • путь внутри окружения Python (venv) отдаёт окружение проекта;
   *   • другой абсолютный путь — свой (человек или пресет);
   *   • голая команда разрешается через PATH.
   */
  private originOf(config: LspServerConfig): LspServerOrigin {
    if (config.env?.ELECTRON_RUN_AS_NODE) return 'bundled';
    const command = config.command;
    const withPath = path.isAbsolute(command) || command.includes(path.sep);
    if (!withPath) return 'path';
    return this.isEnvironmentCommand(command) ? 'python' : 'settings';
  }

  /**
   * Сервер из окружения проекта: рядом с его корнем лежит `pyvenv.cfg` (venv) или
   * `conda-meta` (окружение conda). Имя каталога тут не подсказка — `/usr/bin` тоже
   * называется `bin`, и по имени мы бы звали системный сервер «окружением проекта».
   * Ответ помним по команде: `status` спрашивают часто, а диск — не бесплатный.
   */
  private isEnvironmentCommand(command: string): boolean {
    const cached = this.environmentCommands.get(command);
    if (cached !== undefined) return cached;
    const root = path.dirname(path.dirname(command));
    const result = existsSync(path.join(root, 'pyvenv.cfg')) || existsSync(path.join(root, 'conda-meta'));
    this.environmentCommands.set(command, result);
    return result;
  }

  /**
   * Выполнить запрос к документу, открыв его серверу при необходимости и закрыв
   * после — если открывали мы. Общий уговор у скелета, ссылок и перехода: текст
   * приходит снаружи (файловой системы у сервиса нет), а открытие/закрытие не
   * должно остаться на совести вызывающего.
   */
  private async withDocument<T>(
    runtime: ServerRuntime,
    path: string,
    languageId: string,
    text: string,
    run: (uri: string) => Promise<T>,
  ): Promise<T> {
    await runtime.initialized.catch(() => undefined);
    // Открыт ли документ — вопрос ИМЕННО к карте открытых (`openedIn`), а не к
    // `runtimeForPath`: тот с некоторых пор находит сервер и по расширению, и
    // спрашивать его здесь значило бы считать открытым любой файл языка.
    const opened = this.openedIn.get(path) === runtime;
    const uri = pathToFileURL(path).toString();
    if (opened) {
      // Документ у сервера уже открыт, но его копия могла отстать: файл правили на
      // диске (агент, внешний инструмент, сохранение без открытой вкладки), а `didChange`
      // ему никто не слал. Тогда сервер отвечал по старому тексту — и скелет, и ссылки
      // описывали код, которого в файле уже нет. Отдаём ему тот текст, который спросили.
      this.change(path, text);
    } else {
      this.transient.add(path);
      runtime.connection.notify('textDocument/didOpen', {
        textDocument: { uri, languageId, version: 1, text },
      });
    }
    try {
      return await run(uri);
    } finally {
      if (!opened) this.closeAfterDiagnostics(runtime, path, uri);
    }
  }

  /**
   * Закрыть документ, который открывали сами, — но сперва дать серверу сказать про него
   * пометки.
   *
   * `publishDiagnostics` приходит уже ПОСЛЕ `didOpen`, и мгновенный `didClose` выбрасывал
   * их вместе с ответом: обход проекта читал файлы, а счётчик ошибок оставался пустым.
   * Ждём ровно до первого слова сервера (или до срока) и тогда закрываем.
   *
   * Есть приёмник пометок (обход проекта) — иначе закрываем сразу: чужому запросу
   * (ссылки, переход) держать файл открытым незачем.
   */
  private closeAfterDiagnostics(runtime: ServerRuntime, path: string, uri: string): void {
    const close = (): void => {
      this.transient.delete(path);
      // Сервер мог перезапуститься, пока мы ждали: чужому процессу `didClose` не нужен.
      if (this.runtimes.get(runtime.config.language) !== runtime) return;
      runtime.connection.notify('textDocument/didClose', { textDocument: { uri } });
    };
    if (!this.diagnosticsSink || this.languageOfPath.has(path)) {
      close();
      return;
    }
    const wait = this.awaitDiagnostics(path);
    void wait.done.then(() => {
      wait.cancel();
      close();
    });
  }

  /**
   * Язык файла для запроса к серверу: сперва то, что уже знает редактор (он
   * открывал файл и назвал язык), затем — по расширению. Неизвестный язык
   * вернёт null: сервера для него всё равно нет.
   */
  languageFor(path: string): string | null {
    return this.languageOfPath.get(path) ?? languageInfoForPath(path)?.id ?? null;
  }

  private onNotification(method: string, params: unknown): void {
    // Прогресс: сервер говорит, чем занят, и как далеко зашёл. Отдаём в окно, чтобы
    // долгая работа (индексация, поиск) была видна, а не выглядела зависанием.
    if (method === '$/progress') {
      const progress = parseProgress(params);
      if (progress) this.publish(PushTopic.LspProgress, progress);
      return;
    }
    if (method !== 'textDocument/publishDiagnostics') return;
    const payload = params as {
      uri?: string;
      diagnostics?: unknown[];
      version?: unknown;
    };
    if (typeof payload.uri !== 'string') return;
    // uri → путь: у сервиса свой корень, но file:// понимает и fileURLToPath.
    let path: string;
    try {
      path = fileURLToPath(payload.uri);
    } catch {
      return;
    }
    // Устаревшая публикация: сервер посчитал пометки для прежней версии текста, а мы
    // уже правили файл. Показать их — значит подчеркнуть то, чего на экране нет.
    const runtime = this.runtimeForPath(path);
    if (runtime && typeof payload.version === 'number') {
      const known = runtime.versions.get(path);
      if (known !== undefined && payload.version < known) return;
    }
    const diagnostics = toDiagnostics(payload.diagnostics);
    this.publish(PushTopic.LspDiagnostics, { path, diagnostics });
    // Обход проекта берёт пометки тем же окном `didOpen` (см. `collectDiagnostics`).
    // Открытые в редакторе файлы туда не идут: их пометки и так приходят своим путём,
    // иначе одни и те же ошибки посчитались бы дважды.
    //
    // Пустой список для файла, который обход уже закрыл, — служебное эхо закрытия
    // (`didClose` у части серверов отвечает пустым списком), а не «ошибки исчезли».
    // Без этой отсечки обход сам стирал бы всё, что только что нашёл.
    if (this.diagnosticsSink && !this.languageOfPath.has(path)) {
      if (diagnostics.length > 0 || !this.sweptClosed.has(path)) this.diagnosticsSink(path, diagnostics);
    }
    // Кто держал файл открытым ради пометок — дождался: можно закрывать.
    this.settleDiagnostics(path);
  }

  /**
   * Включить сбор пометок по всему проекту. Сервер шлёт их только для открытых
   * документов, а обход символов (см. `SymbolIndexer`) всё равно открывает каждый
   * файл — пометки приходят тем же окном и не стоят нам отдельного обхода.
   *
   * Возвращает выключатель: сбор живёт ровно столько, сколько идёт обход.
   */
  collectDiagnostics(sink: (path: string, diagnostics: LspDiagnostic[]) => void): () => void {
    this.diagnosticsSink = sink;
    return () => {
      if (this.diagnosticsSink === sink) this.diagnosticsSink = null;
    };
  }

  /**
   * Подписаться на пометки файла: `done` отпускается первым словом сервера об этом
   * файле или сроком (молчащий сервер файл не удержит). `cancel` — отпустить сразу.
   */
  private awaitDiagnostics(path: string): { done: Promise<void>; cancel: () => void } {
    let release = (): void => {};
    const done = new Promise<void>((resolve) => {
      release = () => {
        const waiters = this.diagnosticWaiters.get(path);
        waiters?.delete(release);
        if (waiters?.size === 0) this.diagnosticWaiters.delete(path);
        resolve();
      };
      const waiters = this.diagnosticWaiters.get(path) ?? new Set<() => void>();
      waiters.add(release);
      this.diagnosticWaiters.set(path, waiters);
    });
    const timer = setTimeout(release, SWEEP_FILE_WAIT_MS);
    timer.unref?.();
    return {
      done,
      cancel: () => {
        clearTimeout(timer);
        release();
      },
    };
  }

  private settleDiagnostics(path: string): void {
    const waiters = this.diagnosticWaiters.get(path);
    if (!waiters) return;
    for (const release of [...waiters]) release();
  }

  /**
   * Пометки всего проекта: открыть серверу каждый файл языка и дать ему сказать своё.
   *
   * Сервер публикует `publishDiagnostics` только для открытых документов, а карта
   * символов на тёплом кэше файлы ему не показывает — и счётчик ошибок в строке
   * состояния оставался пустым, пока человек не откроет файл. Здесь файл открывается
   * ровно на время ответа сервера и закрывается; пометки уезжают тем же приёмником,
   * что и у обхода (`collectDiagnostics`).
   */
  async sweepDiagnostics(runtime: ServerRuntime, root: string): Promise<void> {
    if (!this.diagnosticsSink) return;
    const language = runtime.config.language;
    // Проект обходим один раз на корень и язык: `prewarm` зовут и при повторном
    // открытии того же проекта. Сменился корень — заход нужен новый.
    const mark = `${root}\u0000${language}`;
    if (this.swept.has(mark)) return;
    const listing = await listProjectFiles(root).catch(() => null);
    if (!listing) return;
    // Отметка — только после удачного чтения проекта: сорвавшийся обход диска
    // (папку переносят, корень ещё не готов) — не повод молчать до перезапуска.
    this.swept.add(mark);
    const files = listing.files.filter((file) => languageInfoForPath(file)?.id === language).slice(0, SWEEP_MAX_FILES);
    if (files.length === 0) return;
    // Свой прошлый заход начинается заново, чужой (другой корень, другой язык) — нет:
    // второй язык не должен стереть отметки первого, иначе эхо его закрытий просочится.
    for (const closed of [...this.sweptClosed]) if (closed.startsWith(root + path.sep)) this.sweptClosed.delete(closed);
    // Держим память под контролем: файлов в больших проектах тысячи, а нам хватает
    // помнить только последние заходы. Выкидываем самые старые поштучно, а не разом:
    // общий `clear()` сорвал бы чужой заход, и эхо его закрытий стёрло бы найденное.
    while (this.sweptClosed.size > SWEEP_MAX_FILES * 2) {
      const oldest = this.sweptClosed.values().next().value;
      if (oldest === undefined) break;
      this.sweptClosed.delete(oldest);
    }
    const queue = [...files];
    const worker = async (): Promise<void> => {
      for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
        // Проект сменили или сервер перезапустили — заход больше ни к чему.
        if (this.runtimes.get(language) !== runtime) return;
        await this.sweepFile(runtime, path.join(root, file), language);
      }
    };
    await Promise.all(Array.from({ length: SWEEP_CONCURRENCY }, worker));
  }

  private async sweepFile(runtime: ServerRuntime, file: string, languageId: string): Promise<void> {
    // Второй `didOpen` одного пути серверу не нужен: открытая вкладка и обход символов
    // сами принесут его пометки.
    if (this.languageOfPath.has(file) || this.transient.has(file)) return;
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text === null || text.length > SWEEP_MAX_BYTES) return;
    if (this.languageOfPath.has(file) || this.transient.has(file)) return;
    const uri = pathToFileURL(file).toString();
    // Сервер с `diagnosticProvider` спрашиваем напрямую: не ждём, пока он соизволит
    // опубликовать пометки, и не держим ради этого файл открытым. Иначе — как было:
    // `didOpen` и ожидание публикации (см. `awaitDiagnostics`).
    if (runtime.capabilities.diagnosticProvider) {
      const items = await this.diagnosticsFor(file, text);
      if (items) {
        this.sweptClosed.add(file);
        this.publish(PushTopic.LspDiagnostics, { path: file, diagnostics: items });
        return;
      }
    }
    const wait = this.awaitDiagnostics(file);
    this.transient.add(file);
    runtime.connection.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text },
    });
    await wait.done;
    wait.cancel();
    this.transient.delete(file);
    // Дальше сервер может прислать пустой список на закрытие — его не слушаем.
    this.sweptClosed.add(file);
    if (this.runtimes.get(runtime.config.language) !== runtime) return;
    runtime.connection.notify('textDocument/didClose', { textDocument: { uri } });
  }

  /**
   * Запросы сервера к клиенту. Отвечаем только на то, что действительно умеем.
   *
   * Динамическую регистрацию (client/registerCapability) НЕ поддерживаем: мы не заявляем
   * `dynamicRegistration` ни в одной возможности, поэтому сервер не вправе её просить.
   * Если попросит — честно отвечаем `MethodNotFound`: согласиться значило бы пообещать
   * работу, которой нет (см. правило «объявлять лишь то, что доводим»).
   */
  private onRequest(method: string, params: unknown): unknown {
    // Сервер просит создать индикатор прогресса — разрешаем: сам индикатор рисуем мы,
    // уведомления придут тем же `$/progress` (см. `onNotification`).
    if (method === 'window/workDoneProgress/create') return null;
    if (method === 'workspace/configuration') {
      const items = (params as { items?: Array<{ section?: string }> }).items ?? [];
      const python = this.pythonPath();
      return items.map((item) => (item.section === 'python' && python ? { pythonPath: python } : null));
    }
    throw new RpcRequestError(-32601, `Метод не поддерживается: ${method}`);
  }

  private stop(language: string): void {
    const runtime = this.runtimes.get(language);
    if (!runtime) return;
    this.runtimes.delete(language);
    // Следующий заход — уже на новом сервере, старые отметки обхода не в счёт.
    // Только своих: у другого языка сервер жив и его заход продолжается.
    for (const mark of [...this.swept]) if (mark.endsWith(`\u0000${language}`)) this.swept.delete(mark);
    for (const closed of [...this.sweptClosed]) {
      if (languageInfoForPath(closed)?.id === language) this.sweptClosed.delete(closed);
    }
    for (const path of [...this.diagnosticWaiters.keys()]) {
      if (languageInfoForPath(path)?.id === language) this.settleDiagnostics(path);
    }
    this.diagnosticWaiters.clear();
    // `transient` здесь НЕ чистим: каждый, кто открывал документ, снимает свою пометку
    // сам (`closeAfterDiagnostics`/`sweepFile`). Очистка здесь снесла бы пометки
    // живого сервера другого языка — и следующий запрос открыл бы документ дважды.
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

/** Код правила из ответа: строка как есть, число — в строку. Иначе — не задан. */
function codeOf(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw.trim()) return raw;
  if (typeof raw === 'number') return String(raw);
  if (raw && typeof raw === 'object' && typeof (raw as { value?: unknown }).value === 'string') {
    return (raw as { value: string }).value;
  }
  return undefined;
}

/** LSP-диагностика (0-based, severity 1..4) → наш формат (1-based, текстом). */
function toDiagnostics(raw: unknown): LspDiagnostic[] {
  if (!Array.isArray(raw)) return [];
  const out: LspDiagnostic[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const value = item as {
      range?: {
        start?: { line?: number; character?: number };
        end?: { line?: number; character?: number };
      };
      severity?: number;
      message?: unknown;
      source?: unknown;
      code?: unknown;
    };
    const start = value.range?.start;
    const end = value.range?.end;
    if (!start || typeof start.line !== 'number' || typeof start.character !== 'number') continue;
    out.push({
      severity: downgradeSeverity(SEVERITY[value.severity ?? 3] ?? 'info', codeOf(value.code)),
      line: start.line + 1,
      column: start.character + 1,
      endLine: typeof end?.line === 'number' ? end.line + 1 : start.line + 1,
      endColumn: typeof end?.character === 'number' ? end.character + 1 : start.character + 1,
      message: typeof value.message === 'string' ? value.message : String(value.message ?? ''),
      source: typeof value.source === 'string' ? value.source : undefined,
      ...(codeOf(value.code) ? { code: codeOf(value.code) } : {}),
    });
  }
  return out;
}

/**
 * Доводы к `initialize`: путь к питону проекта плюс собственные доводы сервера.
 *
 * Питон нужен всем питоновским серверам (иначе они не видят пакеты окружения), а
 * свои доводы приходят у серверов из поставки — например, путь к `tsserver.js`.
 * Свои идут последними: если они о том же поле, пусть решает конфиг сервера.
 * Слияние — вглубь: `settings` поставки не должен стереть `settings.python`, иначе
 * питон потеряется ровно у тех серверов, что пришли со своими доводами.
 */
function buildInitializationOptions(
  runtime: ServerRuntime,
  python: string | null,
): Record<string, unknown> | undefined {
  const base: Record<string, unknown> = python
    ? { pythonPath: python, settings: { python: { pythonPath: python } } }
    : {};
  const own = (runtime.config.initializationOptions ?? {}) as Record<string, unknown>;
  const settings = {
    ...(base.settings as Record<string, unknown> | undefined),
    ...(own.settings as Record<string, unknown> | undefined),
  };
  const merged: Record<string, unknown> = {
    ...base,
    ...own,
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  };
  // Путь к `tsserver` — из поставки, и он главнее: `typescript-language-server` берёт
  // `typescript` из `node_modules` проекта, а там с TypeScript 7 нет `tsserver.js`
  // (компилятор переписан, отдельного сервера больше нет). Без своего пути сервер
  // отказывает на `initialize` целиком, и язык остаётся без скелета и ссылок.
  const bundledTsserver = (own.tsserver as Record<string, unknown> | undefined)?.path;
  if (typeof bundledTsserver === 'string' && bundledTsserver.length > 0) {
    merged.tsserver = {
      ...(own.tsserver as Record<string, unknown>),
      path: bundledTsserver,
    };
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Подпись сервера в состоянии: у серверов поставки есть своя (`label`), у прочих её
 * нет — показываем имя команды без пути.
 */
function baseName(command: string): string {
  const index = Math.max(command.lastIndexOf('/'), command.lastIndexOf('\\'));
  return index < 0 ? command : command.slice(index + 1);
}
