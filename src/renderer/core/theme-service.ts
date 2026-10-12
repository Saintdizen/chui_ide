import { PushTopic, type ThemeChangedPayload, type ThemeChoice } from '../../shared/api';
import { Emitter } from './events';
import type { RpcClient } from './rpc';
import type { ThemeFile } from '../../shared/theme-file';
import { setThemeOverrides, themeCssVariables, type Scheme } from './theme';

export type { ThemeChoice };

/**
 * Тема выбирается в main-процессе: он выставляет `nativeTheme.themeSource`,
 * и CSS переключается сам — Chromium сразу отдаёт новое значение
 * `prefers-color-scheme`, никаких правок в DOM для этого не нужно.
 *
 * А то, что CSS-переменными не описать (терминал xterm), получает схему от main
 * push-событием: полагаться на событие `matchMedia` в renderer нельзя — оно
 * обновляется не во всех окружениях и может прийти с задержкой.
 */
export class ThemeService {
  private choice: ThemeChoice;
  private scheme: Scheme;
  private custom: ThemeFile | null;
  /** Что мы выставили на корне документа: при снятии темы из файла это и убираем. */
  private cssKeys: string[] = [];

  private readonly emitter = new Emitter<Scheme>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly rpc: RpcClient,
    initial: ThemeChoice,
    initialCustom: ThemeFile | null = null,
  ) {
    this.choice = initial;
    this.custom = initialCustom;
    // Тема из файла задаёт схему жёстко: «как в системе» тут уже не решает.
    this.scheme =
      initialCustom?.scheme ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    setThemeOverrides(this.custom);
    this.applyCss();

    rpc.onPush((message) => {
      if (message.topic !== PushTopic.ThemeChanged) return;
      const payload = message.payload as ThemeChangedPayload;
      this.choice = payload.theme;
      this.custom = payload.customTheme ?? null;
      // Переопределения ставим ДО рассылки: подписчики пересобирают краски
      // из текущих значений, и они должны быть уже новыми.
      setThemeOverrides(this.custom);
      this.applyCss(payload.scheme);
      this.fire(payload.scheme);
    });
  }

  get selected(): ThemeChoice {
    return this.choice;
  }

  /** Фактическая схема с учётом «системной». */
  get resolved(): Scheme {
    return this.scheme;
  }

  /** Разослать схему подписчикам (редактор, xterm, чат). Без аргумента берётся текущая. */
  apply(scheme: Scheme = this.scheme): void {
    this.fire(scheme);
  }

  /**
   * Схему шлём всегда, даже если она та же: вместе с ней могла смениться тема из
   * файла, а подписчики должны пересобрать краски (редактор, кеш подсветки чата).
   */
  private fire(scheme: Scheme): void {
    this.scheme = scheme;
    this.emitter.fire(scheme);
  }

  /**
   * Тема из файла красит обвязку сама — своими значениями на корне документа.
   * Встроенные схемы этого не требуют: их задаёт таблица стилей. Снимая тему,
   * убираем ровно те переменные, что выставляли.
   */
  private applyCss(scheme: Scheme = this.scheme): void {
    const root = document.documentElement;
    for (const key of this.cssKeys) root.style.removeProperty(key);
    this.cssKeys = [];
    if (!this.custom) return;
    for (const [key, value] of Object.entries(themeCssVariables(scheme))) {
      root.style.setProperty(key, value);
      this.cssKeys.push(key);
    }
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
