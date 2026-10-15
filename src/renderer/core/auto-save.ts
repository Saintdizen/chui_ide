import {
  autoSaveAction,
  type AutoSaveMode,
  type AutoSaveTrigger,
  normalizeAutoSaveDelay,
} from '../../shared/auto-save';

/**
 * Автосохранение в редакторе: по событию решает, писать ли файлы на диск, и держит
 * паузу после правки.
 *
 * Решение («писать сейчас / через паузу / не писать») — в `shared/auto-save.ts`,
 * здесь только таймер и запись. Таймер и часы подменяемы: тест проверяет
 * поведение, не ожидая секунду и не завися от реального времени.
 *
 * Сохраняет не сам: `save` вызывает тот, у кого есть документы и диск (см. `app.ts`).
 * Зовётся она только когда есть что писать — проверку «грязных» файлов делает `save`.
 */

export interface AutoSaveDeps {
  /** Режим из настроек: читается на каждое событие — настройку меняют на ходу. */
  mode: () => AutoSaveMode;
  /** Задержка «через паузу», мс. */
  delay: () => number;
  /** Записать несохранённые файлы. */
  save: () => Promise<void>;
  /** Планировщик (для тестов — подставной). */
  schedule?: (run: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export class AutoSave {
  private handle: unknown = null;
  private readonly schedule: (run: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  /** Запись идёт: новое событие не должно запускать вторую. */
  private saving = false;

  constructor(private readonly deps: AutoSaveDeps) {
    this.schedule = deps.schedule ?? ((run, ms) => setTimeout(run, ms));
    this.cancel = deps.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Правка текста (человеком): по режиму — сразу или через паузу. */
  documentChanged(): void {
    this.handleTrigger('typing');
  }

  /** Активный файл сменился (открыли другой): часть режимов пишет здесь. */
  activeDocumentChanged(): void {
    this.handleTrigger('focus-change');
  }

  /** Окно потеряло фокус — самый надёжный момент что-то записать. */
  windowBlurred(): void {
    this.handleTrigger('window-blur');
  }

  /** Настройки изменились: пауза могла укоротиться или режим выключиться. */
  settingsChanged(): void {
    // Ждать прежней задержкой нечего: отменяем запланированное и решаем заново —
    // выключенный режим должен снять и уже назначенную запись.
    this.clearTimer();
    if (this.deps.mode() === 'afterDelay') this.handleTrigger('typing');
  }

  /** Отменить запланированное (закрытие окна, смена проекта). */
  cancelPending(): void {
    this.clearTimer();
  }

  /** Записать сейчас, не дожидаясь паузы (закрытие вкладки, выход). */
  async flush(): Promise<void> {
    this.clearTimer();
    await this.runSave();
  }

  private handleTrigger(trigger: AutoSaveTrigger): void {
    const mode = this.deps.mode();
    const action = autoSaveAction(mode, trigger);
    if (action === 'none') return;
    if (action === 'now') {
      this.clearTimer();
      void this.runSave();
      return;
    }
    // «Через паузу»: каждый новый ввод отодвигает запись — пишем, когда человек
    // остановился, а не посреди набора.
    this.clearTimer();
    this.handle = this.schedule(() => {
      this.handle = null;
      void this.runSave();
    }, normalizeAutoSaveDelay(this.deps.delay()));
  }

  private clearTimer(): void {
    if (this.handle === null) return;
    this.cancel(this.handle);
    this.handle = null;
  }

  private async runSave(): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    try {
      await this.deps.save();
    } finally {
      this.saving = false;
    }
  }
}
