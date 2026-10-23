import { describe, expect, it } from 'vitest';
import type { DefineCommand } from '../src/renderer/core/command-args';
import { registerDebugCommands, type DebugCommandDeps } from '../src/renderer/core/debug-commands';

type Run = (...args: unknown[]) => unknown;

function setup(opts: { phase?: string; active?: { path: string } | null; answer?: string | null } = {}) {
  const commands = new Map<string, Run>();
  const define: DefineCommand = (descriptor, handler) => commands.set(descriptor.id, handler);
  const log: string[] = [];
  const toasts: { text: string; kind?: string }[] = [];
  const deps = {
    debug: {
      get: () => ({ phase: opts.phase ?? 'idle' }),
      resume: async () => log.push('resume'),
      stop: async () => log.push('stop'),
      step: async (kind: string) => log.push(`step:${kind}`),
      toggleBreakpoint: async (path: string, line: number) => {
        log.push(`bp:${path}:${line}`);
        return [{ line, enabled: true }];
      },
      attach: async (options: { port: number; target: string }) => {
        log.push(`attach:${options.target}:${options.port}`);
        return { ok: true, message: '' };
      },
    },
    openEditors: { active: opts.active ?? null },
    editors: {
      cursor: () => ({ line: 7 }),
      setBreakpoints: (_path: string, breakpoints: { line: number }[]) =>
        log.push(`set:${breakpoints.map((b) => b.line).join(',')}`),
    },
    dock: { show: (id: string) => log.push(`dock:${id}`) },
    promptValue: async () => (opts.answer === undefined ? null : opts.answer),
    launchOptions: {
      open: (spec: { onAccept(options: unknown): void }) => {
        log.push('open-options');
        spec.onAccept({ program: 'x.py' });
      },
    },
    activeDebuggableFile: () => ({ path: '/p/x.py' }),
    startDebug: async (options?: unknown) => log.push(`start:${JSON.stringify(options ?? null)}`),
    getLaunchOptions: () => ({ program: 'kept.py' }),
    setLaunchOptions: (options: unknown) => log.push(`setOptions:${JSON.stringify(options)}`),
    scheduleSave: () => log.push('save-session'),
    showToast: (text: string, kind?: string) => toasts.push({ text, kind }),
  } as unknown as DebugCommandDeps;
  registerDebugCommands(define, deps);
  return { commands, log, toasts };
}

const run = (f: ReturnType<typeof setup>, id: string) => f.commands.get(id)!();

describe('registerDebugCommands', () => {
  it('регистрирует девять команд отладки', () => {
    expect([...setup().commands.keys()].sort()).toEqual([
      'debug.attach',
      'debug.continue',
      'debug.start',
      'debug.startWithOptions',
      'debug.stepInto',
      'debug.stepOut',
      'debug.stepOver',
      'debug.stop',
      'debug.toggleBreakpoint',
    ]);
  });

  it('F5 запускает, когда отладки нет, и продолжает, когда она идёт', async () => {
    const idle = setup();
    await run(idle, 'debug.continue');
    expect(idle.log).toEqual(['start:null']);
    const running = setup({ phase: 'paused' });
    await run(running, 'debug.continue');
    expect(running.log).toEqual(['resume']);
  });

  it('шаги и остановка идут в контроллер', async () => {
    const f = setup();
    await run(f, 'debug.stepOver');
    await run(f, 'debug.stepInto');
    await run(f, 'debug.stepOut');
    await run(f, 'debug.stop');
    expect(f.log).toEqual(['step:over', 'step:into', 'step:out', 'stop']);
  });

  it('подключение: нечисловой порт — ошибка и никаких запросов', async () => {
    const f = setup({ answer: 'не порт' });
    await run(f, 'debug.attach');
    expect(f.toasts).toEqual([{ text: 'Порт — это число от 1 до 65535', kind: 'error' }]);
    expect(f.log).toEqual([]);
  });

  it('подключение: порт из ответа, панель показана после успеха', async () => {
    const f = setup({ answer: '9229', active: { path: '/p/a.py' } });
    await run(f, 'debug.attach');
    expect(f.log).toEqual(['attach:node:9229', 'dock:debug']);
  });

  it('отмена окна порта — тихий отказ', async () => {
    const f = setup({ answer: null });
    await run(f, 'debug.attach');
    expect(f.log).toEqual([]);
    expect(f.toasts).toEqual([]);
  });

  it('параметры запуска принимаются, запоминаются и идут в запуск', async () => {
    const f = setup();
    await run(f, 'debug.startWithOptions');
    expect(f.log).toEqual([
      'open-options',
      'setOptions:{"program":"x.py"}',
      'save-session',
      'start:{"program":"x.py"}',
    ]);
  });

  it('точка останова: строка курсора активного файла, без файла — молчание', async () => {
    const f = setup({ active: { path: '/p/a.ts' } });
    await run(f, 'debug.toggleBreakpoint');
    expect(f.log).toEqual(['bp:/p/a.ts:7', 'set:7']);
    const empty = setup();
    await run(empty, 'debug.toggleBreakpoint');
    expect(empty.log).toEqual([]);
  });
});
