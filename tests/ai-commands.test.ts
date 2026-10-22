import { describe, expect, it } from 'vitest';
import type { DefineCommand } from '../src/renderer/core/command-args';
import { registerAiCommands, type AiCommandDeps } from '../src/renderer/core/ai-commands';

type Run = (...args: unknown[]) => unknown;

function setup(enabled = true) {
  const commands = new Map<string, Run>();
  const define: DefineCommand = (descriptor, handler) => commands.set(descriptor.id, handler);
  const log: string[] = [];
  const toasts: string[] = [];
  const deps = {
    aiEnabled: () => enabled,
    warnAiDisabled: () => toasts.push('AI выключен'),
    chat: {
      newChat: () => log.push('newChat'),
      openRunLog: () => log.push('runLog'),
      stop: () => log.push('stop'),
      askAboutSelection: async (kind: string) => log.push(`ask:${kind}`),
    },
    revealChat: () => log.push('reveal'),
    toggleChat: () => log.push('toggle'),
    telemetryModal: { open: () => log.push('telemetry') },
    diagnoseHighlighting: () => 'report',
    showToast: (message: string) => toasts.push(message),
  } as unknown as AiCommandDeps;
  registerAiCommands(define, deps);
  return { commands, log, toasts };
}

const run = (f: ReturnType<typeof setup>, id: string) => f.commands.get(id)!();

describe('registerAiCommands', () => {
  it('регистрирует восемь команд (generateTest остался в app.ts)', () => {
    expect(setup().commands.size).toBe(8);
  });

  it('вход в чат требует включённого AI', () => {
    const f = setup(false);
    for (const id of ['ai.newChat', 'ai.toggle', 'ai.explainSelection', 'ai.fixSelection']) {
      run(f, id);
    }
    expect(f.log).toEqual([]);
    expect(f.toasts).toHaveLength(4);
  });

  it('диагностика и остановка работают при выключенном AI', () => {
    const f = setup(false);
    run(f, 'ai.runLog');
    run(f, 'ai.stop');
    expect(f.log).toEqual(['runLog', 'stop']);
    expect(f.toasts).toEqual([]);
  });

  it('объяснение и исправление сначала показывают чат', async () => {
    const f = setup();
    await run(f, 'ai.explainSelection');
    await run(f, 'ai.fixSelection');
    expect(f.log).toEqual(['reveal', 'ask:explain', 'reveal', 'ask:fix']);
  });

  it('новый диалог показывает панель и начинает беседу', () => {
    const f = setup();
    run(f, 'ai.newChat');
    expect(f.log).toEqual(['reveal', 'newChat']);
  });
});
