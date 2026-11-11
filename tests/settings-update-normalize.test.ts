import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * `SettingsStore.update` — единственный вход для правок из формы.
 *
 * Всё, что пришло из формы, — строки и какие попало числа: тот же путь, что
 * и файл с диска, поэтому нормализация здесь не косметика. Без неё кривое
 * значение из поля живёт в памяти до перезапуска и потом исчезает — хуже
 * всего тем, что расхождение видно только после рестарта.
 */

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
}));

const { SettingsStore } = await import('../src/main/settings');

const dirs: string[] = [];

async function storeWith(contents: unknown): Promise<InstanceType<typeof SettingsStore>> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-settings-'));
  dirs.push(dir);
  const file = path.join(dir, 'settings.json');
  await fs.writeFile(file, JSON.stringify(contents), 'utf8');
  return new SettingsStore(file);
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('SettingsStore.update: нормализация входа формы', () => {
  it('неизвестный режим автосохранения заменяется умолчанием', async () => {
    const store = await storeWith({ editor: {} });
    const fallback = store.get().editor.autoSave;
    store.update({ editor: { autoSave: 'когда-нибудь' as never } });
    expect(store.get().editor.autoSave).toBe(fallback);
  });

  it('задержка автосохранения поджимается, а не пишется как есть', async () => {
    const store = await storeWith({ editor: {} });
    store.update({ editor: { autoSaveDelayMs: 10 ** 9 } });
    const value = store.get().editor.autoSaveDelayMs;
    expect(value).toBeLessThan(10 ** 9);
    expect(value).toBeGreaterThan(0);
  });

  it('булевы флаги берутся только ровно булевыми', async () => {
    const store = await storeWith({ editor: {} });
    const before = store.get().editor.minimap;
    // `1` не приравнивается к `true` намеренно: значение приходит из JSON
    // формы, и молчаливое «единица — значит да» скрыло бы чужой формат.
    store.update({ editor: { minimap: 1 as never, wordWrap: 0 as never } });
    expect(store.get().editor.minimap).toBe(before);
    expect(store.get().editor.wordWrap).toBe(false);
  });

  it('патч не затирает настройки, которых в нём нет', async () => {
    const store = await storeWith({ editor: { fontSize: 15 } });
    store.update({ editor: { wordWrap: true } });
    expect(store.get().editor.fontSize).toBe(15);
    expect(store.get().editor.wordWrap).toBe(true);
  });

  it('editor: большой размер шрифта срезается до потолка, а не падает', async () => {
    const store = await storeWith({});
    store.update({ editor: { fontSize: 500 } });
    expect(store.get().editor.fontSize).toBeLessThanOrEqual(72);
  });

  it('editor: дробный размер шрифта — целое, иначе кеш-ключ ищет мимо', async () => {
    const store = await storeWith({});
    store.update({ editor: { fontSize: 13.7 } });
    expect(Number.isInteger(store.get().editor.fontSize)).toBe(true);
  });

  it('editor: tabSize как есть — числовой вход не приводится', async () => {
    const store = await storeWith({});
    store.update({ editor: { tabSize: 0 } });
    // Не санируется — так и остаётся: `update` не стережёт диапазон,
    // и это видно в файле настроек руками. Поведение зафиксировано,
    // чтобы правка его не сломала молча.
    expect(store.get().editor.tabSize).toBe(0);
  });

  it('explorer: настройки сохраняются как пришли', async () => {
    const store = await storeWith({});
    store.update({ explorer: { sort: 'name', indent: 24 } });
    expect(store.get().explorer.sort).toBe('name');
    expect(store.get().explorer.indent).toBe(24);
  });

  it('гранты правок без команды или без пути не сохраняются', async () => {
    const store = await storeWith({ ai: {} });
    store.update({ ai: { editGrants: [{}, { command: 'a' }, { path: '/x' }] as never } });
    expect(store.get().ai.editGrants).toEqual([]);
  });

  it('помеченные секреты не попадают в файл настроек', async () => {
    const store = await storeWith({ ai: { provider: 'openai' } });
    store.update({ ai: { apiKey: 'sk-1' } as never });
    const raw = await fs.readFile(store.file(), 'utf8');
    expect(raw).not.toContain('sk-1');
  });

  it('rememberRoots отбрасывает активный корень не из набора', async () => {
    const store = await storeWith({});
    store.rememberRoots(['/a', '/b'], '/чужой');
    expect(store.get().workspace.activeRoot).toBe('/a');
    expect(store.get().workspace.roots).toEqual(['/a', '/b']);
  });

  it('rememberRoots без корней оставляет активный пустым', async () => {
    const store = await storeWith({});
    store.rememberRoots([], '/a');
    expect(store.get().workspace.activeRoot).toBeNull();
  });
});
