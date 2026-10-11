import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, promises as fs, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BROWSER_EXECUTABLES,
  normalizeBrowserUrl,
  parseDevToolsEndpoint,
  SNAPSHOT_SCRIPT,
  sanitizeSnapshot,
  type BrowserSnapshot,
} from '../../shared/browser';
import { CdpConnection } from '../debug/cdp';

/**
 * Браузерная автоматизация: свой Chromium, управляемый по CDP.
 *
 * Своего браузера у IDE нет и быть не должно: агент работает в настоящем
 * Chromium, запущенном отдельным процессом с отдельным профилем в temp. Поэтому
 * он ничего не знает о закладках и сессиях человека, а закрывается вместе с ним.
 *
 * Разговор идёт по Chrome DevTools Protocol — тем же клиентом, что и отладчик
 * (`main/debug/cdp.ts`). Порт браузер выбирает сам (`--remote-debugging-port=0`),
 * а узнать его можно только из строки в stderr — её и разбирает `parseDevToolsEndpoint`.
 * Подключаемся прямо к вкладке: тогда команды идут без sessionId, и клиент остаётся
 * тем же, что у отладчика.
 *
 * Проверяемая часть — адрес, снимок и его разбор — лежит в `shared/browser.ts`.
 */

export interface BrowserLaunchOptions {
  /** Путь к исполняемому файлу; пусто — ищем в PATH по известным именам. */
  executable?: string;
  /** Без окна: так браузер не отвлекает и работает на машинах без экрана. */
  headless: boolean;
}

/** Что умеет браузер для инструментов агента. Полный `BrowserService` подходит сюда структурно. */
export interface BrowserTools {
  /** Перейти на адрес; возвращает снимок страницы после загрузки. */
  open(url: string): Promise<BrowserSnapshot>;
  /** Снимок текущей страницы. */
  snapshot(): Promise<BrowserSnapshot>;
  /** Нажать элемент по номеру из снимка; возвращает новый снимок. */
  click(ref: string): Promise<BrowserSnapshot>;
  /** Ввести текст в поле; `submit` — отправить форму клавишей Enter. */
  type(ref: string, text: string, submit: boolean): Promise<BrowserSnapshot>;
  /** Выполнить выражение на странице и вернуть результат текстом. */
  evaluate(expression: string): Promise<string>;
  /** Закрыть браузер и убрать временный профиль. */
  close(): Promise<void>;
}

/** Ожидание загрузки: страница бывает медленной, но ждать её вечно нельзя. */
const LOAD_TIMEOUT_MS = 20_000;
/** Сколько ждём строку DevTools при запуске: холодный старт Chrome бывает долгим. */
const LAUNCH_TIMEOUT_MS = 20_000;
/** Потолок результата `browser_evaluate`: это ответ модели, а не дамп памяти. */
const MAX_EVALUATE_CHARS = 8000;

export class BrowserService implements BrowserTools {
  private child: ChildProcess | null = null;
  private connection: CdpConnection | null = null;
  private profileDir: string | null = null;
  /** Запуск идёт прямо сейчас: два `browser_open` не должны поднять два браузера. */
  private starting: Promise<void> | null = null;

  constructor(private readonly options: () => BrowserLaunchOptions) {}

  /** Идёт ли сессия: инструменты предлагаются только при включённой настройке. */
  get running(): boolean {
    return this.child !== null && this.connection !== null && !this.connection.closed;
  }

  async open(rawUrl: string): Promise<BrowserSnapshot> {
    const normalized = normalizeBrowserUrl(rawUrl);
    if (!normalized.ok) throw new Error(normalized.reason);

    const connection = await this.ensure();
    await connection.send('Page.navigate', { url: normalized.url });
    await this.waitForLoad();
    return this.snapshot();
  }

  async snapshot(): Promise<BrowserSnapshot> {
    const connection = await this.ensure();
    const result = await connection.send('Runtime.evaluate', {
      expression: SNAPSHOT_SCRIPT,
      returnByValue: true,
      awaitPromise: false,
    });
    const value = (result as { result?: { value?: unknown } }).result?.value;
    return sanitizeSnapshot(value);
  }

  async click(ref: string): Promise<BrowserSnapshot> {
    const connection = await this.ensure();
    const outcome = await evaluateOnPage(
      connection,
      `(() => {
        const node = document.querySelector('[data-chui-ref="${escapeRef(ref)}"]');
        if (!node) return { ok: false, reason: 'элемент не найден' };
        node.scrollIntoView({ block: 'center', inline: 'center' });
        if (typeof node.click === 'function') node.click();
        else node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return { ok: true };
      })()`,
    );

    const answer = outcome as { ok?: boolean; reason?: string } | null;
    if (!answer?.ok) throw new Error(answer?.reason ?? 'не удалось нажать элемент');
    await settle();
    return this.snapshot();
  }

  async type(ref: string, text: string, submit: boolean): Promise<BrowserSnapshot> {
    const connection = await this.ensure();
    const focused = await evaluateOnPage(
      connection,
      `(() => {
        const node = document.querySelector('[data-chui-ref="${escapeRef(ref)}"]');
        if (!node) return { ok: false, reason: 'элемент не найден' };
        node.scrollIntoView({ block: 'center', inline: 'center' });
        node.focus();
        // Выделяем прежнее содержимое: ввод заменяет его, а не дописывает.
        if (typeof node.select === 'function') node.select();
        else if (typeof node.setSelectionRange === 'function') node.setSelectionRange(0, (node.value || '').length);
        return { ok: true };
      })()`,
    );

    const answer = focused as { ok?: boolean; reason?: string } | null;
    if (!answer?.ok) throw new Error(answer?.reason ?? 'не удалось найти поле');

    // Ввод делаем средствами CDP, а не присваиванием значения: так событие
    // приходит настоящим, и React-подобные формы его видят.
    await connection.send('Input.insertText', { text });
    if (submit) {
      for (const type of ['keyDown', 'keyUp']) {
        await connection.send('Input.dispatchKeyEvent', {
          type,
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
          text: type === 'keyDown' ? '\r' : undefined,
        });
      }
      await this.waitForLoad();
    }
    await settle();
    return this.snapshot();
  }

  async evaluate(expression: string): Promise<string> {
    const text = expression.trim();
    if (!text) throw new Error('Пустое выражение');
    const connection = await this.ensure();
    const result = (await connection.send('Runtime.evaluate', {
      expression: text,
      returnByValue: true,
      awaitPromise: true,
    })) as {
      result?: { value?: unknown; description?: string };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    };

    if (result.exceptionDetails) {
      const reason = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'ошибка';
      throw new Error(`Выражение завершилось ошибкой: ${reason.split('\n')[0]}`);
    }

    const value = result.result?.value;
    const rendered = value === undefined ? (result.result?.description ?? 'undefined') : render(value);
    return rendered.length > MAX_EVALUATE_CHARS ? `${rendered.slice(0, MAX_EVALUATE_CHARS)}\n… (обрезано)` : rendered;
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.connection?.close();
    this.connection = null;
    this.starting = null;
    if (child && child.exitCode === null) child.kill('SIGTERM');

    const dir = this.profileDir;
    this.profileDir = null;
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  /** Закрыть всё при выходе приложения: процесс браузера не должен остаться висеть. */
  dispose(): void {
    void this.close();
  }

  /** Запустить браузер, если он ещё не запущен, и вернуть живое соединение. */
  private async ensure(): Promise<CdpConnection> {
    if (this.connection && !this.connection.closed && this.child) return this.connection;
    if (this.starting) {
      await this.starting;
      if (this.connection && !this.connection.closed) return this.connection;
    }
    this.starting = this.launch();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
    if (!this.connection) throw new Error('Браузер не запустился');
    return this.connection;
  }

  private async launch(): Promise<void> {
    const settings = this.options();
    const executable = resolveExecutable(settings.executable);
    if (!executable) {
      throw new Error(
        'Chromium не найден. Укажите путь к браузеру в настройках («Браузер») или поставьте его в систему.',
      );
    }

    const profileDir = mkdtempSync(path.join(os.tmpdir(), 'chui-browser-'));
    this.profileDir = profileDir;

    const args = [
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-extensions',
      '--disable-sync',
      // Запускаем сразу с пустой страницей: тогда вкладка есть с первой секунды,
      // и не нужно ждать, пока её создаст сам браузер.
      'about:blank',
    ];
    if (settings.headless) args.unshift('--headless=new');
    else args.push('--window-size=1280,900');

    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;

    let stderr = '';
    const endpoint = await new Promise<{ wsUrl: string; httpUrl: string } | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), LAUNCH_TIMEOUT_MS);
      const stop = (value: { wsUrl: string; httpUrl: string } | null): void => {
        clearTimeout(timer);
        resolve(value);
      };
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        const found = parseDevToolsEndpoint(stderr);
        if (found) stop(found);
        if (stderr.length > 20_000) stderr = stderr.slice(-4000); // держим хвост, а не весь лог
      });
      child.on('error', () => stop(null));
      child.on('exit', () => stop(null));
    });

    if (!endpoint) {
      const hint = stderr.trim().split('\n').slice(-3).join('\n');
      await this.close();
      throw new Error(
        hint
          ? `Браузер не сообщил отладочный порт. Похоже, он не запустился: ${hint}`
          : 'Браузер не сообщил отладочный порт — вероятно, он не запустился.',
      );
    }

    const pageUrl = await this.waitForPage(endpoint.httpUrl);
    if (!pageUrl) {
      await this.close();
      throw new Error('Браузер запустился, но вкладку не открыл');
    }

    // Процесс умер сам (человек закрыл окно) — сессия кончилась: сбрасываем
    // состояние, чтобы следующий вызов поднял браузер заново, а не бил в мёртвый сокет.
    child.on('exit', () => {
      if (this.child === child) {
        this.child = null;
        this.connection?.close();
        this.connection = null;
      }
    });

    this.connection = await CdpConnection.connect(pageUrl, LAUNCH_TIMEOUT_MS);
    await this.connection.send('Page.enable');
    await this.connection.send('Runtime.enable');
  }

  /** Вкладка появляется не мгновенно: спрашиваем список целей, пока она не найдётся. */
  private async waitForPage(httpBase: string): Promise<string | null> {
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.child) return null;
      try {
        const response = await fetch(`${httpBase}/json/list`);
        const targets = (await response.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
        const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      } catch {
        // порт ещё не слушает — пробуем снова
      }
      await settle(120);
    }
    return null;
  }

  /** Ждём, пока документ догрузится: `Page.navigate` отвечает до загрузки. */
  private async waitForLoad(): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const state = await evaluateOnPage(connection, `document.readyState`);
        if (state === 'complete') return;
      } catch {
        return; // страница не отвечает — пусть снимок покажет, что вышло
      }
      await settle(150);
    }
  }
}

/** Найти исполняемый файл браузера: сперва заданный путь, потом известные имена в PATH. */
export function resolveExecutable(configured?: string): string | null {
  const explicit = configured?.trim();
  if (explicit) return existsSync(explicit) ? explicit : null;

  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const name of BROWSER_EXECUTABLES) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Выражение на странице; значение — то, что вернул `Runtime.evaluate`. */
async function evaluateOnPage(connection: CdpConnection, expression: string): Promise<unknown> {
  const result = (await connection.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as {
    result?: { value?: unknown };
    exceptionDetails?: { exception?: { description?: string } };
  };
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description?.split('\n')[0] ?? 'выражение не выполнилось');
  }
  return result.result?.value;
}

/** Номер из снимка подставляется в селектор — экранируем, чтобы метка не сломала его. */
function escapeRef(ref: string): string {
  return ref.trim().replace(/[^0-9]/g, '');
}

/** Пауза: даём странице перерисоваться после действия. */
function settle(ms = 250): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Значение из `Runtime.evaluate` в текст: строка — как есть, объект — JSON. */
function render(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
