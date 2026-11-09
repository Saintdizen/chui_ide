import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findPrimaryVenvSync } from '../src/main/python/environments';

/**
 * Окружение Python в ответе сборки (п.60).
 *
 * Решение по пункту: отдельного инструмента `venv` нет — у модели нет дела,
 * которое ему отдать. А вот *знать* про окружение она обязана: иначе зовёт
 * `python`, тот берёт системный пакет, и сборка падает на «модуль не найден»
 * там, где он установлен.
 *
 * Поэтому — одна строка в ответе `run`, только когда окружение есть.
 */

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-venv-note-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('окружение Python', () => {
  it('без окружения — не находим и молчим', () => {
    expect(findPrimaryVenvSync(dir)).toBeNull();
  });

  it('.venv в корне проекта находится — путём к python', async () => {
    await fs.mkdir(path.join(dir, '.venv', 'bin'), { recursive: true });
    await fs.writeFile(path.join(dir, '.venv', 'bin', 'python'), '', 'utf8');
    const found = findPrimaryVenvSync(dir);
    expect(found).not.toBeNull();
    expect(found).toContain(path.join('.venv', 'bin', 'python'));
  });

  it('venv тоже годится', async () => {
    await fs.mkdir(path.join(dir, 'venv', 'bin'), { recursive: true });
    await fs.writeFile(path.join(dir, 'venv', 'bin', 'python'), '', 'utf8');
    expect(findPrimaryVenvSync(dir)).toContain('venv');
  });
});
