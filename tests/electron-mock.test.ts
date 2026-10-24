import { existsSync, promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Подделка electron сама должна быть честной. Если эти проверки упадут, значит
 * мок начал прощать то, чего настоящий electron не прощает, — и 5589 зелёных
 * тестов станут зелёными ни за что.
 */
describe('tests/mocks/electron', () => {
  it('app.getPath(userData) — настоящий существующий каталог', async () => {
    const { app } = await import('electron');
    const dir = app.getPath('userData');
    expect(existsSync(dir)).toBe(true);
    await fs.writeFile(`${dir}/probe.txt`, 'ok');
    expect(await fs.readFile(`${dir}/probe.txt`, 'utf8')).toBe('ok');
  });

  it('shell и dialog бросают, а не делают вид, что сработали', async () => {
    const { shell, dialog } = await import('electron');
    await expect(shell.openExternal('https://example.com')).rejects.toThrow(/юнит-тестах его нет/);
    await expect(dialog.showOpenDialog({})).rejects.toThrow(/юнит-тестах его нет/);
  });

  it('ipcMain.handle записывает канал — его можно проверить', async () => {
    const { ipcMain, ipcHandlers } = await import('electron');
    const handler = (): void => {};
    ipcMain.handle('probe:call', handler);
    expect(ipcHandlers.get('probe:call')).toBe(handler);
    ipcMain.removeHandler('probe:call');
    expect(ipcHandlers.has('probe:call')).toBe(false);
  });

  it('мок подставлен и тестам, и src/main', async () => {
    const direct = await import('electron');
    const viaSrc = await import('../src/main/ai/chat-store');
    expect(direct.app.getPath('userData')).toContain('chui-electron-');
    expect(typeof viaSrc.ChatStore).toBe('function');
  });
});
