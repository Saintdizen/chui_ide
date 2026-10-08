import { PushTopic, type ThemeChangedPayload, type ThemeChoice } from '../../shared/api';
import { Emitter } from './events';
import type { RpcClient } from './rpc';
import { MONACO_THEME_IDS, type Scheme } from './theme';

export type { ThemeChoice };

/**
 * Тема выбирается в main-процессе: он выставляет `nativeTheme.themeSource`,
 * и CSS переключается сам — Chromium сразу отдаёт новое значение
 * `prefers-color-scheme`, никаких правок в DOM для этого не нужно.
 *
 * А то, что CSS-переменными не описать (Monaco, xterm), получает схему от main
 * push-событием: полагаться на событие `matchMedia` в renderer нельзя — оно
 * обновляется не во всех окружениях и может прийти с задержкой.
 */
export class ThemeService {
  private choice: ThemeChoice;
  private scheme: Scheme;
  private applied: Scheme | null = null;

  private readonly emitter = new Emitter<Scheme>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly rpc: RpcClient,
    initial: ThemeChoice,
  ) {
    this.choice = initial;
    this.scheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

    rpc.onPush((message) => {
      if (message.topic !== PushTopic.ThemeChanged) return;
      const payload = message.payload as ThemeChangedPayload;
      this.choice = payload.theme;
      this.apply(payload.scheme);
    });
  }

  get selected(): ThemeChoice {
    return this.choice;
  }

  /** Фактическая схема с учётом «системной». */
  get resolved(): Scheme {
    return this.scheme;
  }

  get monacoThemeId(): string {
    return MONACO_THEME_IDS[this.scheme];
  }

  /** Разослать схему подписчикам (Monaco, xterm). Без аргумента берётся текущая. */
  apply(scheme: Scheme = this.scheme): void {
    this.scheme = scheme;
    if (this.applied === scheme) return;
    this.applied = scheme;
    this.emitter.fire(scheme);
  }

  async set(choice: ThemeChoice): Promise<void> {
    this.choice = choice;
    // main применит выбор и пришлёт событие с фактической схемой — именно она
    // решает, какую палитру взять: «системная» может оказаться любой из двух.
    await this.rpc.request('settings.update', { appearance: { theme: choice } });
  }

  async toggle(): Promise<void> {
    await this.set(this.scheme === 'dark' ? 'light' : 'dark');
  }
}
