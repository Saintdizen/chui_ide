import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createJobRegistry, JOB_TIMEOUT_MS, MAX_JOBS } from '../src/main/ai/jobs';

/**
 * Задания: долгая команда не держит шаг.
 *
 * Проверяем три свойства, ради которых задание и заведено: вывод можно дочитать
 * с того места, где остановился (а не заново), задание кончается вместе с
 * процессом и видно, чем именно, и брошенное задание можно снять.
 *
 * Процессы настоящие, но короткие и запускаются напрямую (`exec`), без оболочки:
 * иначе пришлось бы писать команды, одинаковые в `sh` и `cmd`.
 */

const node = process.execPath;
const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chui-jobs-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Дождаться состояния: процессы асинхронные, а проверка должна быть устойчивой. */
async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались состояния');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('реестр заданий', () => {
  it('задание печатает, кончается и отдаёт вывод', async () => {
    const registry = createJobRegistry();
    const job = registry.start({
      command: 'node -e print',
      cwd: process.cwd(),
      exec: { file: node, args: ['-e', 'console.log("начало"); setTimeout(function(){console.log("конец")}, 50)'] },
    });

    await until(() => job.snapshot().status !== 'running');
    const snapshot = job.snapshot();
    expect(snapshot.status).toBe('completed');
    expect(snapshot.code).toBe(0);

    const read = job.read(0);
    expect(read.data).toContain('начало');
    expect(read.data).toContain('конец');
    expect(read.offset).toBe(read.data.length);
  });

  it('читается только новый вывод: смещение не повторяет прочитанное', async () => {
    const registry = createJobRegistry();
    const job = registry.start({
      command: 'node -e two-lines',
      cwd: process.cwd(),
      exec: {
        file: node,
        args: [
          '-e',
          'console.log("первая"); setTimeout(function(){console.log("вторая")}, 150); setTimeout(function(){}, 300)',
        ],
      },
    });

    await until(() => job.read(0).data.includes('первая'));
    const first = job.read(0);
    await until(() => job.read(first.offset).data.includes('вторая'));
    const second = job.read(first.offset);

    // Второе чтение отдаёт только то, чего ещё не было.
    expect(second.data).toContain('вторая');
    expect(second.data).not.toContain('первая');
    expect(second.offset).toBeGreaterThan(first.offset);
  });

  it('упавший процесс виден как «упало» и с кодом', async () => {
    const registry = createJobRegistry();
    const job = registry.start({
      command: 'node -e fail',
      cwd: process.cwd(),
      exec: { file: node, args: ['-e', 'process.exit(3)'] },
    });

    await until(() => job.snapshot().status !== 'running');
    expect(job.snapshot().status).toBe('failed');
    expect(job.snapshot().code).toBe(3);
  });

  it('задание можно снять, и процесс не остаётся жить', async () => {
    const registry = createJobRegistry();
    const job = registry.start({
      command: 'node -e long',
      cwd: process.cwd(),
      // Долгий сон без печати: снимать будем до его конца.
      exec: { file: node, args: ['-e', 'setTimeout(function(){}, 60000)'] },
    });

    expect(job.snapshot().status).toBe('running');
    job.stop();
    await until(() => job.snapshot().status === 'failed' || job.snapshot().status === 'completed');
    expect(job.snapshot().code === 0).toBe(false);
  });

  it('список показывает задания, а незнакомый номер не находится', () => {
    const registry = createJobRegistry();
    const job = registry.start({
      command: 'node -e quick',
      cwd: process.cwd(),
      exec: { file: node, args: ['-e', 'console.log(1)'] },
    });

    expect(registry.list().map((item) => item.id)).toContain(job.snapshot().id);
    expect(registry.get(job.snapshot().id)).not.toBeNull();
    expect(registry.get('job-999')).toBeNull();
  });

  it('больше десятка заданий не заводится — отказ вместо тихой потери', () => {
    const registry = createJobRegistry();
    const long = { file: node, args: ['-e', 'setTimeout(function(){}, 60000)'] };
    for (let index = 0; index < MAX_JOBS; index += 1) {
      registry.start({ command: `long ${index}`, cwd: process.cwd(), exec: long });
    }
    expect(() => registry.start({ command: 'ещё одно', cwd: process.cwd(), exec: long })).toThrow(/Заданий уже/);

    for (const snapshot of registry.list()) registry.get(snapshot.id)?.stop();
  });

  it('предел времени задания разумный', () => {
    // Полчаса: дольше агент всё равно не дождётся, а процесс занимал бы машину.
    expect(JOB_TIMEOUT_MS).toBe(30 * 60_000);
  });
});
