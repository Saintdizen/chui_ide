import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Наблюдение за файлами: о своих правках и чужих изменениях сообщаем в UI.
 *
 * Проверяется шов, а не сам `fs.watch`: запись мимо сервиса (как из терминала
 * или внешнего редактора) должна дойти до подписчика. Правка `.ai_ignore`
 * перечитывает правила сразу — иначе она подействовала бы лишь при следующем
 * открытии проекта, и человек решил бы, что настройка не работает.
 */

const roots: string[] = [];
const services: WorkspaceService[] = [];

afterEach(async () => {
  for (const ws of services.splice(0)) ws.close();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-ws6-')));
  roots.push(dir);
  return dir;
}

function service(events: Array<{ topic: string; payload: unknown }>): WorkspaceService {
  const ws = new WorkspaceService(
    (topic, payload) => events.push({ topic, payload }),
    () => undefined,
  );
  services.push(ws);
  return ws;
}

/** Дождаться события: наблюдатель асинхронный, ждать «просто так» нельзя. */
async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('событие не пришло за отведённое время');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('наблюдение за файлами', () => {
  it('запись мимо сервиса сообщается подписчику', async () => {
    const dir = await makeDir();
    await fs.writeFile(path.join(dir, 'a.ts'), 'const a = 1;\n', 'utf8');
    const events: Array<{ topic: string; payload: unknown }> = [];
    const ws = service(events);
    await ws.open(dir);

    // Пишем НЕ через сервис — так видит правку внешний инструмент.
    await fs.writeFile(path.join(dir, 'a.ts'), 'const a = 2;\n', 'utf8');
    await until(() => events.length > 0);

    expect(events[0].topic).toBe('workspace:changed');
  });

  it('правка .ai_ignore перечитывает правила сразу, а не при переоткрытии', async () => {
    const dir = await makeDir();
    await fs.writeFile(path.join(dir, 'a.ts'), 'x\n', 'utf8');
    const ws = service([]);
    await ws.open(dir);
    const before = ws.ignoreRuleCount();

    // Файл правил есть только сейчас: без перечитывания о нём никто не узнает.
    await fs.writeFile(path.join(dir, '.ai_ignore'), 'секрет/\nчерновики/\nмусор/\n', 'utf8');
    await until(() => ws.ignoreRuleCount() !== before);

    expect(before).toBe(0);
    expect(ws.ignoreRuleCount()).toBe(3);
  });

  it('после close наблюдение снимается: события больше не приходят', async () => {
    const dir = await makeDir();
    await fs.writeFile(path.join(dir, 'a.ts'), 'x\n', 'utf8');
    const events: Array<{ topic: string; payload: unknown }> = [];
    const ws = service(events);
    await ws.open(dir);
    ws.close();

    await fs.writeFile(path.join(dir, 'a.ts'), 'y\n', 'utf8');
    // Даём наблюдателю шанс: если он не снят, событие придёт.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events).toHaveLength(0);
  });
});
