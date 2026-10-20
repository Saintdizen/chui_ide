import type { BrowserZoomMode } from '../../shared/api';
import { normalizeBrowserUrl, type BrowserSnapshot } from '../../shared/browser';
import type { BrowserTools } from './browser';
import { DebuggerChannel } from './debugger-channel';
import type { BrowserPanel } from './panel';
import { PageSession, type CdpChannel } from './session';

/**
 * Браузер агента: встроенный — по умолчанию, отдельный Chromium — по выбору.
 *
 * Раньше агент работал только в своём Chromium (отдельный процесс, профиль в temp):
 * это давало изоляцию от сессий человека, но человек не видел, что агент делает, а
 * «поделиться» залогиненной страницей было нельзя вовсе.
 *
 * Теперь по умолчанию агент работает в ТОЙ ЖЕ странице, что видит человек: вкладка
 * в редакторе, а подключение — по CDP через родной `webContents.debugger` вложения
 * (`debugger-channel.ts`). Логика страницы общая с отдельным браузером и лежит в
 * `session.ts` — различается только транспорт.
 *
 * Изоляция при этом не потерялась, а стала явной: страницы, которые агент открывает
 * САМ, живут во временной сессии (`AGENT_PARTITION` в `panel.ts`) и сессий человека
 * не видят. Свою залогиненную страницу человек отдаёт агенту явно — кнопкой
 * «поделиться»: без неё агент всегда работает в
 * своей вкладке, а человек видит, что там происходит, и может отозвать доступ.
 *
 * Отдельный Chromium остался не «на всякий случай», а как единственный способ
 * проверить страницу в НАСТОЯЩЕМ браузере человека: движок Electron и его Chrome —
 * не одно и то же, и расхождение движков иногда и есть то, что ищут.
 */
export class AgentBrowser implements BrowserTools {
  /** Вкладка агента: одна на сессию, чтобы `browser` (action open) не плодил вкладки. */
  private pageId: string | null = null;
  private channel: CdpChannel | null = null;
  private session: PageSession | null = null;

  constructor(
    private readonly panel: BrowserPanel,
    private readonly external: BrowserTools,
    private readonly useIntegrated: () => boolean,
  ) {}

  open(url: string): Promise<BrowserSnapshot> {
    if (!this.useIntegrated()) return this.external.open(url);
    this.note('open');
    return this.openIntegrated(url);
  }

  snapshot(): Promise<BrowserSnapshot> {
    if (!this.useIntegrated()) return this.external.snapshot();
    this.note('read');
    return this.integratedSession().then((session) => session.snapshot());
  }

  click(ref: string): Promise<BrowserSnapshot> {
    if (!this.useIntegrated()) return this.external.click(ref);
    this.note('click');
    return this.integratedSession().then((session) => session.click(ref));
  }

  type(ref: string, text: string, submit: boolean): Promise<BrowserSnapshot> {
    if (!this.useIntegrated()) return this.external.type(ref, text, submit);
    this.note('type');
    return this.integratedSession().then((session) => session.type(ref, text, submit));
  }

  evaluate(expression: string): Promise<string> {
    if (!this.useIntegrated()) return this.external.evaluate(expression);
    this.note('script');
    return this.integratedSession().then((session) => session.evaluate(expression));
  }

  /**
   * Масштаб страницы — только во встроенном браузере: там масштаб — состояние вкладки,
   * которое видит человек, и агент может показать ему вёрстку в другой ширине.
   * У отдельного Chromium такого понятия в нашей обвязке нет.
   */
  async zoom(mode: BrowserZoomMode): Promise<{ ok: boolean; zoom?: number; reason?: string }> {
    if (!this.useIntegrated()) {
      return { ok: false, reason: 'масштаб доступен только во встроенном браузере' };
    }
    // В какой вкладке работает агент — решает общий доступ: поделённая страница
    // человека важнее собственной вкладки агента.
    const id = this.panel.sharedPageId ?? this.pageId;
    if (!id) return { ok: false, reason: 'Страница ещё не открыта: сначала browser (action open)' };
    this.note('zoom');
    return this.panel.zoom(id, mode);
  }

  /**
   * Сказать renderer'у, что на вкладке действует агент. Без этого человек видит
   * только результат: страница под его руками сама нажимает кнопки, а кто —
   * непонятно. Вкладку берём ту, в которой агент работает сейчас.
   */
  private note(action: string): void {
    const id = this.panel.sharedPageId ?? this.pageId;
    if (id) this.panel.noteAgentAction(id, action);
  }

  async close(): Promise<void> {
    // Закрываем обе сессии: настройку могли переключить по ходу прогона.
    this.channel?.close();
    this.channel = null;
    this.session = null;
    this.pageId = null;
    this.panel.closeAgent();
    await this.external.close();
  }

  /** Открыть страницу вкладкой в IDE и подключиться к ней по CDP. */
  private async openIntegrated(rawUrl: string): Promise<BrowserSnapshot> {
    const normalized = normalizeBrowserUrl(rawUrl);
    if (!normalized.ok) throw new Error(normalized.reason);

    // Человек поделился своей вкладкой — работаем в ней же, а не заводим свою:
    // ради этого общий доступ и заводят (логин, состояние формы, куки).
    const shared = this.panel.sharedPageId;
    if (shared) {
      const session = this.attach(shared);
      await session.navigate(normalized.url);
      return session.snapshot();
    }

    const opened = await this.panel.openForAgent(normalized.url);
    if (!opened.ok || !opened.id) throw new Error(opened.reason ?? 'Не удалось открыть страницу');

    const session = this.attach(opened.id);
    // Вложение уже начало загрузку — ждём её, а не переходим заново.
    await session.waitForLoad();
    return session.snapshot();
  }

  /**
   * Сессия для действий. Поделился человек вкладкой — работаем в ней; иначе — в своей
   * (`pageId`), заведённой `browser` (action open).
   */
  private async integratedSession(): Promise<PageSession> {
    const id = this.panel.sharedPageId ?? this.pageId;
    if (!id) throw new Error('Страница ещё не открыта: сначала browser (action open)');
    return this.attach(id);
  }

  /** Подключиться к вложению вкладки. Повторный вызов на той же вкладке канал не рвёт. */
  private attach(id: string): PageSession {
    if (this.session && this.pageId === id && this.channel && !this.channel.closed) return this.session;

    const contents = this.panel.contents(id);
    if (!contents) throw new Error('Вкладка встроенного браузера закрыта');
    const channel = new DebuggerChannel(contents);
    this.channel = channel;
    this.pageId = id;
    this.session = new PageSession(channel);
    return this.session;
  }
}
