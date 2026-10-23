import { describe, expect, it } from 'vitest';
import { registerMacroCommands, type MacroDeps } from '../src/renderer/core/macro-commands';
import type { DefineCommand } from '../src/renderer/core/command-args';

/**
 * Макросы. Запись молчалива по своей природе — команда обязана сказать, что
 * запись началась и что записалось: иначе человек не понимает, что происходит.
 */
function setup(options: { recording?: boolean; steps?: number; hasFile?: boolean; times?: string } = {}) {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const define: DefineCommand = (descriptor, handler) => commands.set(descriptor.id, handler);
  const toasts: string[] = [];
  const log: string[] = [];
  let recording = options.recording ?? false;
  const steps = Array.from({ length: options.steps ?? 3 }, () => ({}));
  const deps = {
    editors: {
      currentPath: options.hasFile === false ? null : '/proj/a.ts',
      isRecordingMacro: () => recording,
      startMacro: () => {
        recording = true;
        log.push('start');
      },
      stopMacro: () => {
        recording = false;
        log.push('stop');
        return steps;
      },
      macroSteps: () => (options.steps === 0 ? [] : steps),
      playMacro: (list: readonly unknown[]) => list.length,
    },
    showToast: (message: string) => toasts.push(message),
    refreshStatus: () => log.push('status'),
    promptValue: async () => options.times ?? '2',
  } as unknown as MacroDeps;
  registerMacroCommands(define, deps);
  return { commands, toasts, log };
}

describe('registerMacroCommands', () => {
  it('регистрирует три команды макросов', () => {
    const { commands } = setup();
    expect([...commands.keys()].sort()).toEqual(['editor.macroPlay', 'editor.macroPlayCount', 'editor.macroRecord']);
  });

  it('без файла запись не начинается', () => {
    const { commands, toasts, log } = setup({ hasFile: false });
    commands.get('editor.macroRecord')!();
    expect(log).toEqual([]);
    expect(toasts).toEqual(['Нет открытого файла']);
  });

  it('запись переключается той же командой и докладывает результат', () => {
    const { commands, toasts, log } = setup();
    commands.get('editor.macroRecord')!();
    commands.get('editor.macroRecord')!();
    expect(log).toEqual(['start', 'status', 'stop', 'status']);
    expect(toasts).toEqual(['Запись макроса началась: остановить — той же командой', 'Макрос записан: действий 3']);
  });

  it('пустой макрос не выполняется', () => {
    const { commands, toasts } = setup({ steps: 0 });
    commands.get('editor.macroPlay')!();
    expect(toasts).toEqual(['Макрос не записан']);
  });

  it('макрос без открытого файла не выполняется: выполнять негде', () => {
    const { commands, toasts } = setup({ hasFile: false });
    commands.get('editor.macroPlay')!();
    expect(toasts).toEqual(['Откройте файл: макрос выполняется в редакторе']);
  });

  it('«выполнить N раз» выполняет введённое число', async () => {
    const { commands, toasts } = setup({ times: '2' });
    await commands.get('editor.macroPlayCount')!();
    expect(toasts.at(-1)).toContain('2');
  });

  it('пустой ответ на «сколько раз» — не повод выполнять', async () => {
    const { commands, toasts } = setup({ times: '' });
    await commands.get('editor.macroPlayCount')!();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).not.toContain('выполнен');
  });
});
