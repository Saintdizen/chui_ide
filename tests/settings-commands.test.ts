import { describe, expect, it } from 'vitest';
import { registerSettingsCommands, type SettingsDeps } from '../src/renderer/core/settings-commands';
import type { DefineCommand } from '../src/renderer/core/command-args';

/**
 * Настройки: окно и файл на диске. Файл открывает main и сам сообщает путь —
 * команда не должна ни угадывать расположение, ни молчать о результате.
 */
function setup() {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const define: DefineCommand = (descriptor, handler) => commands.set(descriptor.id, handler);
  const opened: number[] = [];
  const toasts: string[] = [];
  const asked: string[] = [];
  const deps = {
    rpc: {
      request: async (method: string) => {
        asked.push(method);
        return { path: '/home/u/.config/chui-ide/settings.json' };
      },
    },
    settingsModal: { open: () => opened.push(1) },
    showToast: (message: string) => toasts.push(message),
  } as unknown as SettingsDeps;
  registerSettingsCommands(define, deps);
  return { commands, opened, toasts, asked };
}

describe('registerSettingsCommands', () => {
  it('регистрирует окно и файл настроек', () => {
    const { commands } = setup();
    expect([...commands.keys()].sort()).toEqual(['settings.open', 'settings.revealFile']);
  });

  it('окно настроек открывается без обращения к main', async () => {
    const { commands, opened, asked } = setup();
    await commands.get('settings.open')!();
    expect(opened).toHaveLength(1);
    expect(asked).toEqual([]);
  });

  it('файл настроек открывает main и показывает путь', async () => {
    const { commands, toasts, asked, opened } = setup();
    await commands.get('settings.revealFile')!();
    expect(asked).toEqual(['settings.revealFile']);
    expect(toasts).toEqual(['Настройки: /home/u/.config/chui-ide/settings.json']);
    expect(opened).toEqual([]);
  });
});
