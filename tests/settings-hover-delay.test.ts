import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Задержка подсказки при наведении — настройка `editor.hoverDelayMs`.
 *
 * Пауза раньше была константой в виджете: человек не мог ни ускорить подсказки,
 * ни избавиться от них. Теперь она живёт в настройках, и проверяется именно стык:
 * значение читается из файла, мусор из файла не ломает редактор, а запись
 * ограничена разумными рамками.
 */

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
}));

const { SettingsStore } = await import('../src/main/settings');

const dirs: string[] = [];

/** Файл настроек во временном каталоге: настоящий settings.json должен». */
async function storeWith(contents: unknown): Promise<InstanceType<typeof SettingsStore>> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-hover-'));
  dirs.push(dir);
  const file = path.join(dir, 'settings.json');
  await fs.writeFile(file, JSON.stringify(contents), 'utf8');
  return new SettingsStore(file);
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('editor.hoverDelayMs', () => {
  it('без настройки — пауза по умолчанию', async () => {
    const store = await storeWith({ editor: {} });
    expect(store.get().editor.hoverDelayMs).toBe(350);
  });

  it('значение из файла читается', async () => {
    const store = await storeWith({ editor: { hoverDelayMs: 900 } });
    expect(store.get().editor.hoverDelayMs).toBe(900);
  });

  it('ноль — законное значение: показывать сразу', async () => {
    const store = await storeWith({ editor: { hoverDelayMs: 0 } });
    expect(store.get().editor.hoverDelayMs).toBe(0);
  });

  it('мусор в файле не ломает паузу — берётся умолчание', async () => {
    const store = await storeWith({ editor: { hoverDelayMs: 'много' } });
    expect(store.get().editor.hoverDelayMs).toBe(350);
  });

  it('из формы значение поджимается, а не пишется как есть', async () => {
    const store = await storeWith({ editor: {} });
    store.update({ editor: { hoverDelayMs: 99_999 } });
    expect(store.get().editor.hoverDelayMs).toBe(350);
  });

  it('записанное в форме значение переживает перезапуск', async () => {
    const store = await storeWith({ editor: {} });
    store.update({ editor: { hoverDelayMs: 250 } });
    const again = new SettingsStore(store.file());
    expect(again.get().editor.hoverDelayMs).toBe(250);
  });
});
