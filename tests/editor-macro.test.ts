import { describe, expect, it } from 'vitest';
import { MAX_MACRO_STEPS } from '../src/shared/macro';
import {
  MacroRecorder,
  recordsCommand,
  runMacro,
  sanitizeMacroSteps,
  type MacroStep,
  type MacroTarget,
} from '../src/renderer/editor/input/macro';

/**
 * Макросы: запись действий и повтор. Проверяется без окна — запись копит шаги, а
 * повтор идёт тем же путём, что нажатие (движение, правка, вставка).
 */
describe('запись макроса', () => {
  it('вне записи шаги не копятся', () => {
    const recorder = new MacroRecorder();
    recorder.push({ kind: 'move', motion: 'left', extend: false });
    expect(recorder.taken()).toEqual([]);
    expect(recorder.isRecording).toBe(false);
  });

  it('во время записи шаги копятся, после остановки — нет', () => {
    const recorder = new MacroRecorder();
    recorder.start();
    expect(recorder.isRecording).toBe(true);
    recorder.push({ kind: 'move', motion: 'down', extend: false });
    recorder.push({ kind: 'insert', text: ';' });
    const steps = recorder.stop();
    expect(steps).toHaveLength(2);
    expect(recorder.isRecording).toBe(false);
    recorder.push({ kind: 'insert', text: 'x' });
    expect(recorder.taken()).toHaveLength(2);
    expect(recorder.length).toBe(2);
  });

  it('новый старт забывает прежний макрос', () => {
    const recorder = new MacroRecorder();
    recorder.start();
    recorder.push({ kind: 'insert', text: 'старое' });
    recorder.start();
    expect(recorder.taken()).toEqual([]);
  });

  it('длина макроса ограничена: зажатая клавиша не растит запись', () => {
    const recorder = new MacroRecorder();
    recorder.start();
    for (let i = 0; i < MAX_MACRO_STEPS + 50; i += 1) recorder.push({ kind: 'insert', text: 'x' });
    expect(recorder.taken()).toHaveLength(MAX_MACRO_STEPS);
  });

  it('макрос можно взять извне (из сессии прошлой работы)', () => {
    const recorder = new MacroRecorder();
    recorder.set([{ kind: 'edit', command: 'deleteLine' }]);
    expect(recorder.taken()).toEqual([{ kind: 'edit', command: 'deleteLine' }]);
    expect(recorder.isRecording).toBe(false);
  });
});

describe('что попадает в макрос', () => {
  it('правки текста записываются', () => {
    expect(recordsCommand('newline')).toBe(true);
    expect(recordsCommand('backspace')).toBe(true);
    expect(recordsCommand('deleteLine')).toBe(true);
  });

  it('панели, переходы и история не записываются', () => {
    for (const command of ['find', 'replace', 'gotoLine', 'palette', 'undo', 'redo', 'codeActions'] as const) {
      expect(recordsCommand(command), command).toBe(false);
    }
  });
});

describe('повтор макроса', () => {
  /** Исполнитель-запись: копит то, что у него попросили, — по нему видно повтор. */
  function recorderTarget(): { target: MacroTarget; log: string[] } {
    const log: string[] = [];
    return {
      log,
      target: {
        move: (motion, extend) => log.push(`move:${motion}:${extend}`),
        edit: (command) => log.push(`edit:${command}`),
        insert: (text) => log.push(`insert:${text}`),
      },
    };
  }

  it('шаги идут по порядку и тем же путём, что нажатие', () => {
    const steps: MacroStep[] = [
      { kind: 'move', motion: 'lineEnd', extend: false },
      { kind: 'insert', text: ';' },
      { kind: 'edit', command: 'newline' },
    ];
    const { target, log } = recorderTarget();
    expect(runMacro(steps, target)).toBe(3);
    expect(log).toEqual(['move:lineEnd:false', 'insert:;', 'edit:newline']);
  });

  it('выделение в шаге движения сохраняется', () => {
    const { target, log } = recorderTarget();
    runMacro([{ kind: 'move', motion: 'down', extend: true }], target);
    expect(log).toEqual(['move:down:true']);
  });

  it('пустой макрос — ноль шагов и никаких вызовов', () => {
    const { target, log } = recorderTarget();
    expect(runMacro([], target)).toBe(0);
    expect(log).toEqual([]);
  });
});

describe('шаги из сессии', () => {
  it('правильные шаги проходят', () => {
    const steps = sanitizeMacroSteps([
      { kind: 'move', motion: 'left', extend: true },
      { kind: 'edit', command: 'deleteLine' },
      { kind: 'insert', text: 'abc' },
    ]);
    expect(steps).toEqual([
      { kind: 'move', motion: 'left', extend: true },
      { kind: 'edit', command: 'deleteLine' },
      { kind: 'insert', text: 'abc' },
    ]);
  });

  it('мусор отбрасывается, а не ломает разбор', () => {
    expect(sanitizeMacroSteps(null)).toEqual([]);
    expect(sanitizeMacroSteps('нет')).toEqual([]);
    expect(
      sanitizeMacroSteps([
        5,
        null,
        { kind: 'нет' },
        { kind: 'move' },
        { kind: 'insert', text: '' },
        { kind: 'insert', text: 'ok' },
      ]),
    ).toEqual([{ kind: 'insert', text: 'ok' }]);
  });

  it('пустое расширение шага движения читается как «без выделения»', () => {
    expect(sanitizeMacroSteps([{ kind: 'move', motion: 'up' }])).toEqual([{ kind: 'move', motion: 'up', extend: false }]);
  });
});
