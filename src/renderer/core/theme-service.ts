import { PushTopic, type ThemeChangedPayload } from '../../shared/api';
import { Emitter } from './events';
import type { RpcClient } from './rpc';
import type { ThemeFile } from '../../shared/theme-file';
import { setThemeOverrides, themeCssVariables } from './theme';

/**
 * Тема из файла. Схема в приложении одна — тёмная, поэтому сервис не выбирает
 * палитру и не спрашивает систему: он держит активную тему из файла и раздаёт
 * подписчикам сигнал «краски сменились».
 *
 * Сигнал нужен потому, что часть оформления CSS-переменными не описать —
 * палитру консоли и подсветку кода в редакторе и чате пересобирают подписчики.
 */
export class ThemeService {
  private custom: ThemeFile | null;
  /** Что мы выставили на корне документа: при снятии темы из файла это и убираем. */
  private cssKeys: string[] = [];

  private readonly emitter = new Emitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(rpc: RpcClient, initialCustom: ThemeFile | null = null) {
    this.custom = initialCustom;
    setThemeOverrides(this.custom);
    this.applyCss();

    rpc.onPush((message) => {
      if (message.topic !== PushTopic.ThemeChanged) return;
      const payload = message.payload as ThemeChangedPayload;
      this.custom = payload.customTheme ?? null;
      // Переопределения ставим ДО рассылки: подписчики пересобирают краски
      // из текущих значений, и они должны быть уже новыми.
      setThemeOverrides(this.custom);
      this.applyCss();
      this.emitter.fire();
    });
  }

  /** Активная тема из файла — или `null`, если работает встроенная палитра. */
  get selected(): ThemeFile | null {
    return this.custom;
  }

  /** Разослать сигнал подписчикам (редактор, терминал, чат). */
  apply(): void {
    this.emitter.fire();
  }

  /**
   * Тема из файла красит обвязку сама — своими значениями на корне документа.
   * Встроенная палитра этого не требует: её задаёт таблица стилей. Снимая тему,
   * убираем ровно те переменные, что выставляли.
   */
  private applyCss(): void {
    const root = document.documentElement;
    for (const key of this.cssKeys) root.style.removeProperty(key);
    this.cssKeys = [];
    if (!this.custom) return;
    for (const [key, value] of Object.entries(themeCssVariables())) {
      root.style.setProperty(key, value);
      this.cssKeys.push(key);
    }
  }
}
