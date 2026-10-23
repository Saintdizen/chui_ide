import { describe, expect, it } from 'vitest';
import { registerPathCommands, type PathDeps } from '../src/renderer/core/path-commands';
import type { DefineCommand } from '../src/renderer/core/command-args';

/**
 * Команды над путём — мелкие, и ценность сторожа не в них самих, а в порядке
 * действий и в отказах: терминал создаётся ДО показа дока, удалённая папка
 * проверяется ДО записи в настройки.
 */
function setup(options: { remoteOk?: boolean; root?: string | null } = {}) {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const define: DefineCommand = (descriptor, handler) => commands.set(descriptor.id, handler);
  const log: string[] = [];
  const toasts: { message: string; kind?: string }[] = [];
  let rootSettingsTarget = '';
  const deps = {
    rpc: {
      request: async (method: string, payload: { path?: string; address?: string }) => {
        log.push(`rpc:${method}:${payload.path ?? payload.address}`);
        if (method === 'remote.check') return { ok: options.remoteOk ?? true, detail: 'ssh ok' };
        return { ok: true };
      },
    },
    workspace: { root: options.root === undefined ? '/proj' : options.root },
    settings: { workspace: { remoteRoots: [] as string[] } },
    saveSettingsPatch: async (patch: { workspace: { remoteRoots: string[] } }) => {
      log.push(`save:${patch.workspace.remoteRoots.join(',')}`);
      return {} as never;
    },
    showToast: (message: string, kind?: 'error') => toasts.push({ message, kind }),
    openPath: async (path: string) => {
      log.push(`open:${path}`);
    },
    editors: { reveal: (path: string, line: number, column: number) => log.push(`reveal:${path}:${line}:${column}`) },
    dock: { show: (view: string) => log.push(`dock:${view}`) },
    terminalPanel: {
      newSession: async (cwd: string) => {
        log.push(`session:${cwd}`);
      },
    },
    historyModal: { open: async (path: string) => log.push(`history:${path}`) },
    remoteFileModal: { open: async (address: string) => log.push(`remoteFile:${address}`) },
    conditionInput: {
      open: (opts: { onAccept(value: string): void }) => {
        log.push('prompt');
        opts.onAccept('ssh://u@h/srv');
      },
    },
    setRootSettingsTarget: (path: string) => {
      rootSettingsTarget = path;
      log.push(`target:${path}`);
    },
    rootSettingsModal: { open: () => log.push('rootSettings') },
  } as unknown as PathDeps;
  registerPathCommands(define, deps);
  return { commands, log, toasts, target: () => rootSettingsTarget };
}

describe('registerPathCommands', () => {
  it('регистрирует десять команд над путём', () => {
    const { commands } = setup();
    expect([...commands.keys()].sort()).toEqual([
      'explorer.rootSettings',
      'file.history',
      'file.openExternal',
      'file.revealAt',
      'file.revealInOS',
      'remote.addRoot',
      'remote.openFile',
      'terminal.openExternal',
      'terminal.openIn',
    ]);
  });

  it('терминал создаёт сессию ДО показа дока, иначе каталог теряется', async () => {
    const { commands, log } = setup();
    await commands.get('terminal.openIn')!('/proj/src');
    expect(log).toEqual(['session:/proj/src', 'dock:terminal']);
  });

  it('без цели терминал идёт в корень области', async () => {
    const { commands, log } = setup();
    await commands.get('terminal.openIn')!();
    expect(log).toEqual(['session:/proj', 'dock:terminal']);
  });

  it('«Перейти к позиции» открывает файл и встаёт на место', async () => {
    const { commands, log } = setup();
    await commands.get('file.revealAt')!('/proj/a.ts', 12, 4);
    expect(log).toEqual(['open:/proj/a.ts', 'reveal:/proj/a.ts:12:4']);
  });

  it('без номера строки позиция начинается с первого символа', async () => {
    const { commands, log } = setup();
    await commands.get('file.revealAt')!('/proj/a.ts');
    expect(log[1]).toBe('reveal:/proj/a.ts:1:1');
  });

  it('удалённая папка проверяется ДО записи в настройки', async () => {
    const { commands, log } = setup({ remoteOk: true });
    await commands.get('remote.addRoot')!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).toEqual(['prompt', 'rpc:remote.check:ssh://u@h/srv', 'save:ssh://u@h/srv']);
  });

  it('недоступная удалённая папка в настройки не попадает', async () => {
    const { commands, log, toasts } = setup({ remoteOk: false });
    await commands.get('remote.addRoot')!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).toEqual(['prompt', 'rpc:remote.check:ssh://u@h/srv']);
    expect(toasts).toEqual([{ message: 'ssh ok', kind: 'error' }]);
  });

  it('настройки папки запоминают цель, по которой открыты', async () => {
    const { commands, log, target } = setup();
    await commands.get('explorer.rootSettings')!('/proj/lib');
    expect(target()).toBe('/proj/lib');
    expect(log).toContain('rootSettings');
  });

  it('без аргумента берётся корень области', async () => {
    const { commands, log, target } = setup();
    await commands.get('explorer.rootSettings')!();
    expect(target()).toBe('/proj');
    expect(log).toContain('rootSettings');
  });

  it('без открытой папки настройки не открываются и говорят почему', async () => {
    const { commands, log, toasts } = setup({ root: null });
    await commands.get('explorer.rootSettings')!();
    expect(log).not.toContain('rootSettings');
    expect(toasts[0]).toEqual({ message: 'Папка не открыта', kind: 'error' });
  });

  it('кривые аргументы не роняют команды', async () => {
    const { commands, log } = setup();
    await commands.get('file.revealInOS')!(undefined);
    await commands.get('remote.openFile')!('');
    await commands.get('file.history')!(42);
    expect(log).toEqual([]);
  });
});
