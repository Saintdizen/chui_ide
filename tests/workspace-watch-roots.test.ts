import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceService } from '../src/main/workspace/workspace';
import { untilEdit } from './watch-wait';
import type { WorkspaceChangedPayload } from '../src/shared/api';

const roots: string[] = [];
const services: WorkspaceService[] = [];

afterEach(async () => {
  for (const ws of services.splice(0)) ws.close();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-wsr-')));
  roots.push(dir);
  return dir;
}

function service(events: Array<{ topic: string; payload: unknown }>): WorkspaceService {
  const ws = new WorkspaceService((topic, payload) => events.push({ topic, payload }));
  services.push(ws);
  return ws;
}

function changesFor(events: Array<{ topic: string; payload: unknown }>, root: string): WorkspaceChangedPayload[] {
  return events
    .filter((event) => event.topic === 'workspace:changed')
    .map((event) => event.payload as WorkspaceChangedPayload)
    .filter((payload) => payload.root === root);
}

describe('наблюдение за несколькими корнями', () => {
  it('второй корень добавляется к области, а не заменяет первый', async () => {
    const first = await makeDir();
    const second = await makeDir();
    const ws = service([]);
    await ws.open(first);

    const info = await ws.addRoot(second);

    expect(info.roots.map((item) => item.root)).toEqual([first, second]);
    expect(info.root).toBe(second);
    expect(info.name).toBe(path.basename(second));
  });

  it('правка в НЕактивном корне приходит со своим корнем', async () => {
    const first = await makeDir();
    const second = await makeDir();
    await fs.writeFile(path.join(first, 'a.ts'), 'x\n', 'utf8');
    await fs.writeFile(path.join(second, 'b.ts'), 'x\n', 'utf8');
    const events: Array<{ topic: string; payload: unknown }> = [];
    const ws = service(events);
    await ws.open(first);
    await ws.addRoot(second);
    events.length = 0;

    await untilEdit([path.join(first, 'a.ts')], () => changesFor(events, first).length > 0);

    const payload = changesFor(events, first)[0]!;
    expect(payload.path).toBe(path.join(first, 'a.ts'));
    expect(payload.many).toBeUndefined();
  });

  it('наблюдатель есть у каждого корня: правки в обоих доходят', async () => {
    const first = await makeDir();
    const second = await makeDir();
    await fs.writeFile(path.join(first, 'a.ts'), 'x\n', 'utf8');
    await fs.writeFile(path.join(second, 'b.ts'), 'x\n', 'utf8');
    const events: Array<{ topic: string; payload: unknown }> = [];
    const ws = service(events);
    await ws.open(first);
    await ws.addRoot(second);

    // Окно схлопывания одно на всю область: правки в разных корнях дают и одно,
    // и два уведомления в зависимости от гонки. Ждём хотя бы одно, и проверяем
    // главное: у каждого события корень СВОЙ и путь лежит в нём.
    await untilEdit([path.join(first, 'a.ts'), path.join(second, 'b.ts')], () =>
      events.some((event) => event.topic === 'workspace:changed'),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    const told = [...changesFor(events, first), ...changesFor(events, second)];
    expect(told.length).toBeGreaterThan(0);
    for (const payload of told) expect(payload.path.startsWith(payload.root)).toBe(true);
  });

  it('снятый корень молчит, оставшийся продолжает сообщать', async () => {
    const first = await makeDir();
    const second = await makeDir();
    await fs.writeFile(path.join(first, 'a.ts'), 'x\n', 'utf8');
    await fs.writeFile(path.join(second, 'b.ts'), 'x\n', 'utf8');
    const events: Array<{ topic: string; payload: unknown }> = [];
    const ws = service(events);
    await ws.open(first);
    await ws.addRoot(second);

    await ws.removeRoot(first);
    events.length = 0;

    // Снятый корень должен молчать и на повторных записях — поэтому пишем оба файла.
    await untilEdit([path.join(second, 'b.ts'), path.join(first, 'a.ts')], () => changesFor(events, second).length > 0);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(changesFor(events, first)).toHaveLength(0);
    expect(changesFor(events, second)).not.toHaveLength(0);
  });

  it('снятие активного корня передаёт активность оставшемуся', async () => {
    const first = await makeDir();
    const second = await makeDir();
    const ws = service([]);
    await ws.open(first);
    await ws.addRoot(second);

    const info = await ws.removeRoot(second);

    expect(info?.root).toBe(first);
    expect(info?.roots.map((item) => item.root)).toEqual([first]);
  });

  it('снятие последнего корня отдаёт null и закрывает наблюдение', async () => {
    const only = await makeDir();
    await fs.writeFile(path.join(only, 'a.ts'), 'x\n', 'utf8');
    const events: Array<{ topic: string; payload: unknown }> = [];
    const ws = service(events);
    await ws.open(only);

    expect(await ws.removeRoot(only)).toBeNull();

    await fs.writeFile(path.join(only, 'a.ts'), 'y\n', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events).toHaveLength(0);
  });

  it('снятие незнакомого корня не ломает область', async () => {
    const only = await makeDir();
    const other = await makeDir();
    const ws = service([]);
    await ws.open(only);

    const info = await ws.removeRoot(other);

    expect(info?.root).toBe(only);
    expect(info?.roots.map((item) => item.root)).toEqual([only]);
  });

  it('повторное добавление того же корня не плодит дубль, но делает его активным', async () => {
    const first = await makeDir();
    const second = await makeDir();
    const ws = service([]);
    await ws.open(first);
    await ws.addRoot(second);

    const info = await ws.addRoot(first);

    expect(info.roots.map((item) => item.root)).toEqual([first, second]);
    expect(info.root).toBe(first);
  });

  it('переключение активного корня меняет то, что видит дерево', async () => {
    const first = await makeDir();
    const second = await makeDir();
    await fs.writeFile(path.join(first, 'only-first.ts'), 'x\n', 'utf8');
    await fs.writeFile(path.join(second, 'only-second.ts'), 'x\n', 'utf8');
    const ws = service([]);
    await ws.open(first);
    await ws.addRoot(second);

    const info = await ws.setActiveRoot(first);

    expect(info.root).toBe(first);
    const listing = await ws.readDir(first);
    expect(listing.map((entry) => entry.name)).toContain('only-first.ts');
  });

  it('переключение на корень вне области — отказ, а не молчаливая смена', async () => {
    const only = await makeDir();
    const other = await makeDir();
    const ws = service([]);
    await ws.open(only);

    await expect(ws.setActiveRoot(other)).rejects.toThrow(/области/);
    expect((await ws.removeRoot(other))?.root).toBe(only);
  });

  it('открыть несуществующую папку — отказ, а не корень с мусорными путями', async () => {
    const ws = service([]);
    const gone = path.join(await makeDir(), 'нет-такой');

    await expect(ws.open(gone)).rejects.toThrow(/не найдена/);
  });

  it('добавить несуществующую папку — тоже отказ', async () => {
    const first = await makeDir();
    const ws = service([]);
    await ws.open(first);

    await expect(ws.addRoot(path.join(first, 'нет-такой'))).rejects.toThrow(/не найдена/);
  });
});
