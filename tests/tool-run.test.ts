import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runTool } from '../src/main/project/tool-run';
import { removeTemp } from './temp';

/**
 * Запуск внешнего инструмента — единственное место, где анализ проекта трогает
 * чужие процессы. Стережём три вещи: вывод доходит, отсутствие инструмента не
 * бросается исключением, и отменённый процесс действительно умирает. Последнее —
 * не мелочь: повисший линтер держит рабочий каталог проекта, и на Windows уборка
 * временной папки падала с `EBUSY`.
 */

const roots: string[] = [];

afterEach(async () => {
  await removeTemp(roots);
});

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-tool-run-'));
  roots.push(root);
  return root;
}

describe('runTool', () => {
  it('отдаёт stdout инструмента', async () => {
    const root = await makeRoot();
    const out = await runTool(process.execPath, ['-e', 'console.log("ok")'], { cwd: root, env: process.env });
    expect(out.trim()).toBe('ok');
  });

  it('инструмента нет — пустой вывод, а не исключение', async () => {
    const out = await runTool(path.join(os.tmpdir(), `chui-no-such-tool-${process.pid}`), [], {
      cwd: os.tmpdir(),
      env: process.env,
    });
    expect(out).toBe('');
  });

  it('отменённый процесс не доживает до своего конца', async () => {
    const root = await makeRoot();
    const marker = path.join(root, 'late.txt');
    const abort = new AbortController();
    const started = Date.now();
    // Заглушка «долгого линтера»: через 600 мс пишет файл. Не убей мы её — промис
    // ждал бы все 600 мс, а файл появился бы.
    const pending = runTool(
      process.execPath,
      ['-e', `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 600)`],
      { cwd: root, env: process.env, signal: abort.signal },
    );
    setTimeout(() => abort.abort(), 100);

    await pending;
    expect(Date.now() - started).toBeLessThan(500);

    await new Promise((resolve) => setTimeout(resolve, 900));
    await expect(fs.stat(marker)).rejects.toThrow();
  });

  it('отменённый до запуска — даже не запускается', async () => {
    const root = await makeRoot();
    const abort = new AbortController();
    abort.abort();
    const out = await runTool(process.execPath, ['-e', 'console.log("не должно быть")'], {
      cwd: root,
      env: process.env,
      signal: abort.signal,
    });
    expect(out).toBe('');
  });
});
