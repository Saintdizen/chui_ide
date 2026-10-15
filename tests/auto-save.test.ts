import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_SAVE_DELAY_MS,
  autoSaveAction,
  normalizeAutoSaveDelay,
  normalizeAutoSaveMode,
} from '../src/shared/auto-save';
import { AutoSave } from '../src/renderer/core/auto-save';

/** Стенд с подставным таймером: пауза «наступает» по нашей команде, а не по часам. */
function standIn(mode: () => ReturnType<typeof normalizeAutoSaveMode>) {
  const running = new Map<number, () => void>();
  let nextHandle = 1;
  const saved = vi.fn(async () => {});
  const controller = new AutoSave({
    mode,
    delay: () => 1000,
    save: saved,
    schedule: (run) => {
      const handle = nextHandle++;
      running.set(handle, run);
      return handle;
    },
    cancel: (handle) => running.delete(handle as number),
  });
  const fireDelay = (): void => {
    const [handle, run] = [...running.entries()][0] ?? [];
    if (handle !== undefined && run) {
      running.delete(handle);
      run();
    }
  };
  return { controller, saved, running, fireDelay };
}

describe('решение об автосохранении', () => {
  it('выключено — не пишет ни на одно событие', () => {
    expect(autoSaveAction('off', 'typing')).toBe('none');
    expect(autoSaveAction('off', 'focus-change')).toBe('none');
    expect(autoSaveAction('off', 'window-blur')).toBe('none');
  });

  it('«через паузу» — только после правки', () => {
    expect(autoSaveAction('afterDelay', 'typing')).toBe('delay');
    expect(autoSaveAction('afterDelay', 'focus-change')).toBe('none');
    expect(autoSaveAction('afterDelay', 'window-blur')).toBe('none');
  });

  it('«при переходе» пишет на смене файла', () => {
    expect(autoSaveAction('onFocusChange', 'focus-change')).toBe('now');
    expect(autoSaveAction('onFocusChange', 'typing')).toBe('none');
  });

  it('«при потере фокуса окна» пишет на blur', () => {
    expect(autoSaveAction('onWindowChange', 'window-blur')).toBe('now');
    expect(autoSaveAction('onWindowChange', 'focus-change')).toBe('none');
  });
});

describe('разбор настроек', () => {
  it('неизвестный режим читается как выключено', () => {
    expect(normalizeAutoSaveMode('после обеда')).toBe('off');
    expect(normalizeAutoSaveMode(undefined)).toBe('off');
    expect(normalizeAutoSaveMode('onWindowChange')).toBe('onWindowChange');
  });

  it('задержка поджимается в разумные рамки', () => {
    expect(normalizeAutoSaveDelay(10)).toBe(200);
    expect(normalizeAutoSaveDelay(999999)).toBe(60_000);
    expect(normalizeAutoSaveDelay('нет')).toBe(AUTO_SAVE_DELAY_MS);
    expect(normalizeAutoSaveDelay(1500)).toBe(1500);
  });
});

describe('таймер автосохранения', () => {
  it('пауза после правки не пишет, пока не истекла', () => {
    const { controller, saved, fireDelay } = standIn(() => 'afterDelay');
    controller.documentChanged();
    expect(saved).not.toHaveBeenCalled();
    fireDelay();
    expect(saved).toHaveBeenCalledTimes(1);
  });

  it('новый ввод отодвигает запись: остаётся одна пауза', () => {
    const { controller, saved, running, fireDelay } = standIn(() => 'afterDelay');
    controller.documentChanged();
    controller.documentChanged();
    expect(running.size).toBe(1);
    fireDelay();
    expect(saved).toHaveBeenCalledTimes(1);
  });

  it('«при переходе» пишет сразу, паузу не ставит', () => {
    const { controller, saved, running } = standIn(() => 'onFocusChange');
    controller.activeDocumentChanged();
    expect(saved).toHaveBeenCalledTimes(1);
    expect(running.size).toBe(0);
  });

  it('выключенный режим не реагирует', () => {
    const { controller, saved } = standIn(() => 'off');
    controller.documentChanged();
    controller.windowBlurred();
    expect(saved).not.toHaveBeenCalled();
  });

  it('смена режима снимает назначенную паузу', () => {
    let mode: ReturnType<typeof normalizeAutoSaveMode> = 'afterDelay';
    const { controller, saved, running } = standIn(() => mode);
    controller.documentChanged();
    expect(running.size).toBe(1);
    mode = 'off';
    controller.settingsChanged();
    expect(running.size).toBe(0);
    expect(saved).not.toHaveBeenCalled();
  });

  it('flush пишет, не дожидаясь паузы', async () => {
    const { controller, saved, running } = standIn(() => 'afterDelay');
    controller.documentChanged();
    await controller.flush();
    expect(saved).toHaveBeenCalledTimes(1);
    expect(running.size).toBe(0);
  });

  it('вторая запись не начинается, пока идёт первая', async () => {
    let release: () => void = () => undefined;
    const saved = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const controller = new AutoSave({ mode: () => 'onFocusChange', delay: () => 1000, save: saved });
    controller.activeDocumentChanged();
    controller.activeDocumentChanged();
    expect(saved).toHaveBeenCalledTimes(1);
    release();
    await Promise.resolve();
  });
});
