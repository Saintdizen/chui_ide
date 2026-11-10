import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PushTopic, type WorkspaceChangedPayload } from '../src/shared/api';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Долгий поток изменений: `git checkout`, распаковка архива, сборка.
 *
 * Окно схлопывания (120 мс) считается от ПЕРВОГО события, поэтому поток длиннее
 * окна рвётся на куски: на каждый кусок приходит своё уведомление, и раз каждое
 * помечено `many`, подписчик (карта символов) пересчитывается целиком заново.
 * Проверяем, что поток схлопывается, но не откладывается бесконечно.
 */
let dir: string;
let workspace: WorkspaceService;
let events: WorkspaceChangedPayload[];

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-burst-')));
  events = [];
  workspace = new WorkspaceService((topic, payload) => {
    if (topic === PushTopic.WorkspaceChanged) events.push(payload as WorkspaceChangedPayload);
  });
  await workspace.open(dir);
});

afterEach(async () => {
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('WorkspaceChanged: долгий поток изменений', () => {
  it('поток длиннее окна даёт одно уведомление, а не по одному на окно', async () => {
    // 60 файлов по 20 мс — около 1.2 с сплошного потока.
    for (let index = 0; index < 60; index += 1) {
      await workspace.writeFile(path.join(dir, `burst${index}.py`), `x = ${index}\n`);
      await sleep(20);
    }
    await sleep(300);

    expect(events.length).toBeGreaterThan(0);
    // Замер до правки: 12 уведомлений на этот поток, и каждое — общий пересчёт.
    expect(events.length).toBeLessThanOrEqual(2);
    for (const event of events) {
      expect(event.many).toBe(true);
      expect(event.path).toBe(dir);
    }
  });

  it('непрерывный поток всё же уведомляет: ожидание ограничено', async () => {
    const started = Date.now();
    let first = 0;
    // Пишем без пауз 1.5 с — поток не утихает ни на окно.
    while (Date.now() - started < 1500) {
      await workspace.writeFile(path.join(dir, 'hot.py'), `x = ${Date.now()}\n`);
      if (events.length > 0 && first === 0) first = Date.now() - started;
    }
    expect(events.length).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(1400);
  });
});
