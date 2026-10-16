import { SNAPSHOT_SCRIPT, sanitizeSnapshot, type BrowserSnapshot } from '../../shared/browser';

/**
 * Работа со страницей по CDP — без знания о том, откуда взялся канал.
 *
 * До этого вся логика страницы жила в `BrowserService` вместе с запуском отдельного
 * Chromium. Но запуск — это одно, а «снять снимок, нажать, набрать текст» — совсем
 * другое, и второе теперь нужно ДВУМ хозяевам:
 *
 *   • отдельному Chromium (`browser.ts`), которым агент пользуется издавна;
 *   • встроенному браузеру (`panel.ts`): страница живёт в `WebContentsView` окна IDE,
 *     и агент подключается к тому же вложению, которое видит человек.
 *
 * Разница между ними ровно одна — транспорт: у отдельного Chromium это WebSocket
 * (`CdpConnection`), у вложения — родной `webContents.debugger`. Поэтому здесь
 * объявлен `CdpChannel`, а запуск переехал в `browser.ts`.
 *
 * Модуль чистый: ни Electron, ни процессов — проверяется тестами без браузера.
 */

/** Минимум, который нужен от транспорта CDP. Оба канала подходят сюда структурно. */
export interface CdpChannel {
  /** Запрос к CDP. Ошибка в ответе и разрыв соединения — отклонённый промис. */
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Подписка на событие CDP. Возвращает функцию отписки. */
  on(method: string, listener: (params: Record<string, unknown>) => void): () => void;
  close(): void;
  readonly closed: boolean;
}

/** Ожидание загрузки: страница бывает медленной, но ждать её вечно нельзя. */
const LOAD_TIMEOUT_MS = 20_000;
/** Потолок результата `browser_evaluate`: это ответ модели, а не дамп памяти. */
const MAX_EVALUATE_CHARS = 8000;

export class PageSession {
  constructor(private readonly channel: CdpChannel) {}

  /** Перейти на адрес и дождаться загрузки: `Page.navigate` отвечает до неё. */
  async navigate(url: string): Promise<void> {
    await this.channel.send('Page.navigate', { url });
    await this.waitForLoad();
  }

  async waitForLoad(): Promise<void> {
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        // `about:blank` тоже «готов», но это ещё не наша страница: и свежее вложение,
        // и только что поднятый Chromium начинают с пустого документа. Без этой
        // оговорки ожидание заканчивалось сразу, и снимок приходил пустым.
        const ready = await evaluateOnPage(
          this.channel,
          `document.readyState === 'complete' && location.href !== 'about:blank'`,
        );
        if (ready === true) return;
      } catch {
        return; // страница не отвечает — пусть снимок покажет, что вышло
      }
      await settle(150);
    }
  }

  async snapshot(): Promise<BrowserSnapshot> {
    const result = await this.channel.send('Runtime.evaluate', {
      expression: SNAPSHOT_SCRIPT,
      returnByValue: true,
      awaitPromise: false,
    });
    const value = (result as { result?: { value?: unknown } }).result?.value;
    return sanitizeSnapshot(value);
  }

  async click(ref: string): Promise<BrowserSnapshot> {
    const outcome = await evaluateOnPage(
      this.channel,
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
    const focused = await evaluateOnPage(
      this.channel,
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
    await this.channel.send('Input.insertText', { text });
    if (submit) {
      for (const type of ['keyDown', 'keyUp']) {
        await this.channel.send('Input.dispatchKeyEvent', {
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
    const result = (await this.channel.send('Runtime.evaluate', {
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
}

/** Выражение на странице; значение — то, что вернул `Runtime.evaluate`. */
async function evaluateOnPage(channel: CdpChannel, expression: string): Promise<unknown> {
  const result = (await channel.send('Runtime.evaluate', {
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
export function settle(ms = 250): Promise<void> {
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
