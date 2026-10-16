import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, promises as fs, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BROWSER_EXECUTABLES,
  normalizeBrowserUrl,
  parseDevToolsEndpoint,
  type BrowserSnapshot,
} from '../../shared/browser';
import { CdpConnection } from '../debug/cdp';
import { PageSession, settle } from './session';

/**
 * Отдельный Chromium под управлением агента: свой процесс и свой профиль в temp.
 *
 * Раньше вся браузерная работа агента шла только здесь. Теперь у неё есть второй
 * хозяин — встроенный браузер (`panel.ts`), где страница живёт вложением окна IDE
 * и агент работает с той же страницей, что видит человек. Логика страницы общая и
 * лежит в `session.ts`; здесь остаётся то, чем эти два пути РАЗЛИЧАЮТСЯ: запуск
 * настоящего Chromium.
 *
 * Зачем этот путь вообще остался: он даёт то, чего вложение дать не может, —
 * проверку страницы в НАСТОЯЩЕМ браузере человека (его Chrome, Brave, Edge), а не
 * в движке Electron. Процесс живёт с пустым профилем в temp, поэтому закладок и
 * сессий человека он не видит, а закрывается вместе с сессией.
 *
 * Порт браузер выбирает сам (`--remote-debugging-port=0`), и узнать его можно
 * только из строки в stderr — её разбирает `parseDevToolsEndpoint`. Подключаемся
 * прямо к вкладке: тогда команды идут без sessionId, и клиент остаётся тем же, что
 * у отладчика.
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

/** Сколько ждём строку DevTools при запуске: холодный старт Chrome бывает долгим. */
const LAUNCH_TIMEOUT_MS = 20_000;

export class BrowserService implements BrowserTools {
  private child: ChildProcess | null = null;
  private connection: CdpConnection | null = null;
  private profileDir: string | null = null;
  /** Сессия страницы: снимок, нажатия, ввод, выражения. Логика — в `session.ts`. */
  private page: PageSession | null = null;
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
    const page = await this.ensure();
    await page.navigate(normalized.url);
    return page.snapshot();
  }

  async snapshot(): Promise<BrowserSnapshot> {
    return (await this.ensure()).snapshot();
  }

  async click(ref: string): Promise<BrowserSnapshot> {
    return (await this.ensure()).click(ref);
  }

  async type(ref: string, text: string, submit: boolean): Promise<BrowserSnapshot> {
    return (await this.ensure()).type(ref, text, submit);
  }

  async evaluate(expression: string): Promise<string> {
    return (await this.ensure()).evaluate(expression);
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.connection?.close();
    this.connection = null;
    this.page = null;
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

  /** Запустить браузер, если он ещё не запущен, и вернуть живую сессию страницы. */
  private async ensure(): Promise<PageSession> {
    if (this.page && this.connection && !this.connection.closed && this.child) return this.page;
    if (this.starting) {
      await this.starting;
      if (this.page && this.connection && !this.connection.closed) return this.page;
    }
    this.starting = this.launch();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
    if (!this.page) throw new Error('Браузер не запустился');
    return this.page;
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
        this.page = null;
      }
    });

    const connection = await CdpConnection.connect(pageUrl, LAUNCH_TIMEOUT_MS);
    this.connection = connection;
    await connection.send('Page.enable');
    await connection.send('Runtime.enable');
    this.page = new PageSession(connection);
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
