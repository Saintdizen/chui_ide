import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeEnv, projectEnv } from '../src/main/project-env';

/**
 * Окружение проекта из `.env` и его слияние с системным. От этого зависит, что
 * терминал, языковой сервер, установка пакетов, тесты и форматирование видят одни
 * и те же значения — раньше `.env` до терминала и LSP не доходил вовсе.
 */
describe('projectEnv', () => {
  it('читает переменные из .env проекта', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'chui-env-'));
    writeFileSync(path.join(root, '.env'), 'DATABASE_URL=postgres://x\n# комментарий\nPORT=8080\n');
    expect(await projectEnv(root)).toEqual({ DATABASE_URL: 'postgres://x', PORT: '8080' });
    rmSync(root, { recursive: true, force: true });
  });

  it('нет .env — пустой объект, а не ошибка', async () => {
    expect(await projectEnv(path.join(tmpdir(), 'chui-none'))).toEqual({});
  });

  it('без проекта читать нечего', async () => {
    expect(await projectEnv(null)).toEqual({});
  });
});

describe('mergeEnv', () => {
  it('переменные проекта важнее системных', () => {
    expect(mergeEnv({ PORT: '1', HOME: '/h' }, { PORT: '8080' })).toEqual({ PORT: '8080', HOME: '/h' });
  });

  it('отбрасывает undefined из process.env', () => {
    expect(mergeEnv({ A: undefined, B: '2' }, {})).toEqual({ B: '2' });
  });

  it('пустой .env не меняет окружение', () => {
    expect(mergeEnv({ A: '1' }, {})).toEqual({ A: '1' });
  });
});
