import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PushTopic, type WorkspaceChangedPayload } from '../src/shared/api';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Уведомление об изменении рабочей папки: одна правка и массовое изменение.
 *
 * Разница принципиальная для тех, кто на событие подписан. По одному пути видно
 * только последний изменённый файл — остальные схлопываются в окне уведомления.
 * Для сохранения этого довольно, а для переключения ветки нет: карта символов,
 * поправив один файл, осталась бы с объявлениями прошлой ветки.
 *
 * Стенд — настоящая папка: событие приходит от собственных записей сервиса, поэтому
 * проверка не зависит от `fs.watch` (он на части платформ молчит).
 */
let dir: string;
let workspace: WorkspaceService;
let events: WorkspaceChangedPayload[];

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-bulk-')));
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

/** Дождаться уведомления: оно приходит по таймеру схлопывания (120 мс). */
async function waitEvent(timeout = 3000): Promise<WorkspaceChangedPayload> {
  const deadline = Date.now() + timeout;
  while (events.length === 0) {
    if (Date.now() > deadline) throw new Error('уведомление не пришло');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return events[0]!;
}

describe('WorkspaceChanged: одна правка и массовое изменение', () => {
  it('одна правка называет свой файл и не помечена как массовая', async () => {
    const file = path.join(dir, 'one.py');
    await workspace.writeFile(file, 'x = 1\n');

    const event = await waitEvent();
    expect(event.path).toBe(file);
    expect(event.many).toBeUndefined();
  });

  it('несколько файлов подряд — это массовое изменение с корнем вместо пути', async () => {
    // Ровно то, что делает `git checkout`: пачка файлов в одном окне.
    for (let index = 0; index < 8; index += 1) {
      await workspace.writeFile(path.join(dir, `file${index}.py`), `x = ${index}\n`);
    }

    const event = await waitEvent();
    expect(event.many).toBe(true);
    // Путь — корень: конкретный файл тут ничего не говорит, менять надо всё.
    expect(event.path).toBe(dir);
  });

  it('соседние правки одного файла не считаются массовыми', async () => {
    const file = path.join(dir, 'same.py');
    for (let index = 0; index < 8; index += 1) await workspace.writeFile(file, `x = ${index}\n`);

    const event = await waitEvent();
    expect(event.many).toBeUndefined();
    expect(event.path).toBe(file);
  });
});
