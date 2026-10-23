import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Повтор наблюдения после сбоя.
 *
 * Настоящий `fs.watch` роняет ошибку только в особых условиях (переполнение
 * inotify, сетевой диск) — по требованию их не воспроизвести. Поэтому `watch`
 * подменён: тест сам решает, когда он «падает». Проверяется то, чего иначе не
 * увидеть: ошибка наблюдателя НЕ роняет сервис, наблюдение поднимается заново
 * само, а после close отложенный повтор не стреляет в закрытый проект.
 */

/** Падающий наблюдатель: эмитит 'error' по команде теста. */
class FakeWatcher extends EventEmitter {
  closed = false;
  close(): void {
    this.closed = true;
  }
}

/** Сколько вызовов `watch` должны бросить (платформа без рекурсии). */
let throwTimes = 0;
/** Сколько раз `watch` реально вызывали: по нему видно отложенный повтор. */
let watchCalls = 0;

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    watch: vi.fn(() => {
      watchCalls += 1;
      if (throwTimes > 0) {
        throwTimes -= 1;
        throw new Error('рекурсивный watch не поддерживается');
      }
      const watcher = new FakeWatcher();
      observers.push(watcher);
      return watcher;
    }),
  };
});

const { WorkspaceService } = await import('../src/main/workspace/workspace');

const roots: string[] = [];
const services: WorkspaceService[] = [];

/**
 * Считаем вызовы `watch` и ловим наблюдателей по ЭМИТУ. Заглядывать в
 * внутренний `roots` нельзя: `close()` обнуляет список, и «наблюдения нет»
 * стало бы неотличимо от «проект закрыт».
 */
const observers: FakeWatcher[] = [];
function lastWatcher(): FakeWatcher {
  const watcher = observers.at(-1);
  if (!watcher) throw new Error('watch не вызывался');
  return watcher;
}

beforeEach(() => {
  throwTimes = 0;
  watchCalls = 0;
  observers.length = 0;
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const ws of services.splice(0)) ws.close();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function openProject(): Promise<WorkspaceService> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-wretry-')));
  roots.push(root);
  await fs.writeFile(path.join(root, 'a.ts'), 'x\n', 'utf8');
  const ws = new WorkspaceService(
    () => undefined,
    () => undefined,
  );
  services.push(ws);
  await ws.open(root);
  return ws;
}

describe('повтор наблюдения', () => {
  it('ошибка наблюдателя не роняет сервис и поднимает наблюдение заново', async () => {
    await openProject();
    expect(watchCalls).toBe(1);
    const first = lastWatcher();

    // Так выглядит переполнение inotify: наблюдатель сообщает ошибку.
    first.emit('error', new Error('ENOSPC: переполнение'));
    expect(first.closed).toBe(true);

    // Повтор ОТЛОЖЕН: сразу после ошибки нового наблюдателя ещё нет.
    expect(watchCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(3100);
    expect(watchCalls).toBe(2);
  });

  it('платформа без рекурсивного watch: наблюдение поднимается повтором', async () => {
    // Первый запуск бросает: наблюдение не встало ни разу.
    throwTimes = 1;
    await openProject();
    expect(watchCalls).toBe(1);
    expect(observers).toHaveLength(0);

    // Повтор через WATCH_RETRY_MS встаёт с первой же попытки.
    await vi.advanceTimersByTimeAsync(3100);
    expect(watchCalls).toBe(2);
    expect(observers).toHaveLength(1);
  });

  it('предел попыток: после исчерпания новых вызовов нет', async () => {
    // watch падает всегда — как на платформе, где рекурсия недоступна вовсе.
    throwTimes = 999999;
    await openProject();

    // WATCH_RETRY_LIMIT = 5, дальше попытки прекращаются.
    await vi.advanceTimersByTimeAsync(3100 * 6);
    expect(watchCalls).toBe(6);

    // Ещё двадцать секунд — тишина: таймер не крутится вхолостую.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(watchCalls).toBe(6);
    expect(observers).toHaveLength(0);
  });

  it('close гасит отложенный повтор — таймер не держит сервис', async () => {
    const ws = await openProject();
    lastWatcher().emit('error', new Error('сбой'));

    // Проект закрыли раньше, чем сработал повтор.
    ws.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(watchCalls).toBe(1);
  });
});
