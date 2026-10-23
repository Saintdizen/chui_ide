import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Удаление — единственная необратимая операция сервиса.
 *
 * Проверяются решения: в корзину уходит именно этот файл, отказ корзины не
 * выглядит как «удалено», выход за пределы проекта не бывает даже при
 * подставном пути, а редактируемый файл удаляют только спросив.
 */

const trashItem = vi.fn<(target: string) => Promise<void>>();
vi.mock('electron', () => ({ shell: { trashItem: (target: string) => trashItem(target) } }));

const { WorkspaceService } = await import('../src/main/workspace/workspace');

const roots: string[] = [];
const services: Array<InstanceType<typeof WorkspaceService>> = [];

async function makeRoot(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-trash-')));
  roots.push(root);
  return root;
}

/** Уведомления наружу: ими сервис говорит деревьям и вкладкам «здесь изменилось». */
const events: Array<{ topic: string; payload: unknown }> = [];

function service(): InstanceType<typeof WorkspaceService> {
  const ws = new WorkspaceService((topic, payload) => events.push({ topic, payload }));
  services.push(ws);
  return ws;
}

beforeEach(() => {
  trashItem.mockReset();
  trashItem.mockResolvedValue(undefined);
  events.length = 0;
});

afterEach(async () => {
  for (const ws of services.splice(0)) ws.close();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('удаление в корзину', () => {
  it('уходит именно запрошенный файл, абсолютным путём', async () => {
    const root = await makeRoot();
    const file = path.join(root, 'a.ts');
    await fs.writeFile(file, 'x\n', 'utf8');
    const ws = service();
    await ws.open(root);

    await ws.trash(path.join(root, 'a.ts'));
    expect(trashItem).toHaveBeenCalledTimes(1);
    // Корзина не поймёт относительный путь.
    expect(trashItem.mock.calls[0]?.[0]).toBe(file);
  });

  it('после корзины файл забыт кэшем и о нём сказали дереву', async () => {
    const root = await makeRoot();
    const file = path.join(root, 'a.ts');
    await fs.writeFile(file, 'x\n', 'utf8');
    const ws = service();
    await ws.open(root);
    // Содержимое прочитано до удаления — проверяем, что кэш о нём забыли.
    await ws.readFile(file);
    await ws.trash(file);
    // Изменение уходит наружу с задержкой (склейка частых правок) — ждём его.
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
    expect(JSON.stringify(events)).toContain('a.ts');
    // Стаб корзины файл не убирает, поэтому список на диске прежний — и это
    // тоже проверка: удаление идёт ЧЕРЕЗ корзину, а не своим rm.
    await expect(fs.readFile(file, 'utf8')).resolves.toBe('x\n');
  });

  it('отказ корзины не превращается в тихое «удалено»', async () => {
    const root = await makeRoot();
    await fs.writeFile(path.join(root, 'a.ts'), 'x\n', 'utf8');
    const ws = service();
    await ws.open(root);

    trashItem.mockRejectedValue(new Error('нет корзины'));
    await expect(ws.trash(path.join(root, 'a.ts'))).rejects.toThrow(/корзин/i);
    // Файл на месте: неудачное удаление не должно ничего терять.
    await expect(fs.readFile(path.join(root, 'a.ts'), 'utf8')).resolves.toBe('x\n');
  });

  it('вне проекта не удаляет, даже если путь выглядит своим', async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const victim = path.join(outside, 'важное.txt');
    await fs.writeFile(victim, 'не трогать\n', 'utf8');
    const ws = service();
    await ws.open(root);

    await expect(ws.trash(victim)).rejects.toThrow();
    expect(trashItem).not.toHaveBeenCalled();
    await expect(fs.readFile(victim, 'utf8')).resolves.toBe('не трогать\n');
  });

  it('корень проекта не удаляется', async () => {
    const root = await makeRoot();
    const ws = service();
    await ws.open(root);

    await expect(ws.trash(root)).rejects.toThrow(/корень/i);
    expect(trashItem).not.toHaveBeenCalled();
  });

  it('редактируемый файл спрашивает того, кто следит за диском, ДО корзины', async () => {
    const root = await makeRoot();
    const file = path.join(root, 'a.ts');
    await fs.writeFile(file, 'x\n', 'utf8');
    const ws = service();
    await ws.open(root);
    const order: string[] = [];
    ws.onBeforeChange = vi.fn(() => {
      order.push('снимок');
    });
    trashItem.mockImplementation(() => {
      order.push('корзина');
      return Promise.resolve();
    });

    await ws.trash(path.join(root, 'a.ts'));
    expect(ws.onBeforeChange).toHaveBeenCalledWith(file, 'delete');
    // Порядок важен: снимок обязан быть ДО удаления, иначе восстанавливать нечего.
    expect(order).toEqual(['снимок', 'корзина']);
    expect(trashItem).toHaveBeenCalledTimes(1);
  });
});
