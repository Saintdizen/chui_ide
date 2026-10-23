import {
  checkMacroTimes,
  DEFAULT_MACRO_TIMES,
  macroPlayCheck,
  macroPlayedNotice,
  macroRecordedNotice,
} from './macro-run';
import type { MacroStep } from '../editor/input/macro';
import type { DefineCommand } from './command-args';

/**
 * Макросы: запись, выполнение и «выполнить N раз». Запись живёт в редакторе —
 * команда только переключает её и объясняет человеку, что произошло: без
 * сообщений запись молча включается и так же молча кончается.
 */

export interface MacroEditor {
  readonly currentPath: string | null;
  isRecordingMacro(): boolean;
  startMacro(): void;
  stopMacro(): readonly MacroStep[];
  macroSteps(): readonly MacroStep[];
  playMacro(steps: readonly MacroStep[]): number;
}

export interface MacroDeps {
  editors: MacroEditor;
  showToast(message: string, kind?: 'info' | 'error'): void;
  /** Статусбар показывает «запись идёт» — обновляем после каждого переключения. */
  refreshStatus(): void;
  promptValue(options: { title: string; label: string; value?: string }): Promise<string | null>;
}

export function registerMacroCommands(define: DefineCommand, deps: MacroDeps): void {
  const { editors, showToast } = deps;

  define({ id: 'editor.macroRecord', title: 'Макрос: начать или остановить запись', category: 'Редактор' }, () => {
    if (!editors.currentPath && !editors.isRecordingMacro()) {
      showToast('Нет открытого файла');
      return;
    }
    if (editors.isRecordingMacro()) {
      const steps = editors.stopMacro();
      showToast(macroRecordedNotice(steps.length));
      deps.refreshStatus();
      return;
    }
    editors.startMacro();
    showToast('Запись макроса началась: остановить — той же командой');
    deps.refreshStatus();
  });

  const playMacro = (times: number): void => {
    const steps = editors.macroSteps();
    const check = macroPlayCheck(steps.length, editors.currentPath !== null);
    if (check.kind === 'refused') {
      showToast(check.message);
      return;
    }
    let done = 0;
    for (let i = 0; i < times; i += 1) done += editors.playMacro(steps);
    showToast(macroPlayedNotice(times, done));
  };

  define({ id: 'editor.macroPlay', title: 'Макрос: выполнить', category: 'Редактор' }, () => playMacro(1));

  define({ id: 'editor.macroPlayCount', title: 'Макрос: выполнить несколько раз…', category: 'Редактор' }, async () => {
    const answer = await deps.promptValue({
      title: 'Сколько раз выполнить макрос?',
      label: 'Число повторов',
      value: String(DEFAULT_MACRO_TIMES),
    });
    if (answer === null) return;
    const check = checkMacroTimes(answer);
    if (check.kind === 'refused') {
      showToast(check.message, 'error');
      return;
    }
    playMacro(check.times);
  });
}
