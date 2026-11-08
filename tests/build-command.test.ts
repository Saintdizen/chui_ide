import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildCandidates, buildCommand } from '../src/main/project/build';

/**
 * `run` не угадывает сборку: источник один — `scripts` из `package.json` и то,
 * чем этот проект собирается. Тест держит три обещания: имени нет — отказ с
 * списком того, что есть; имя есть — команда идёт через менеджер проекта; ни
 * того ни другого — `tsc --noEmit`, а не молчание.
 */

let root = '';

async function project(files: Record<string, unknown>): Promise<void> {
  root = await mkdtemp(path.join(tmpdir(), 'build-cmd-'));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(root, name), JSON.stringify(body, null, 2), 'utf8');
  }
}

beforeEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

describe('buildCommand', () => {
  it('берёт объявленный скрипт сборки', async () => {
    await project({ 'package.json': { scripts: { build: 'tsc -p .' } } });
    const result = await buildCommand(root);
    expect(result).not.toBeNull();
    expect(result!.command).toContain('build');
  });

  it('имя из аргумента важнее умолчания', async () => {
    await project({ 'package.json': { scripts: { build: 'tsc', lint: 'eslint .' } } });
    const result = await buildCommand(root, 'lint');
    expect(result!.command).toContain('lint');
    expect(result!.label).toContain('lint');
  });

  it('чужое имя — не молчание, а null', async () => {
    await project({ 'package.json': { scripts: { build: 'tsc' } } });
    expect(await buildCommand(root, 'deploy')).toBeNull();
  });

  it('без scripts и без локального tsc — null, а не выдуманное', async () => {
    await project({ 'tsconfig.json': {} });
    // Сборка не врёт: без node_modules/typescript запускать нечего.
    expect(await buildCommand(root)).toBeNull();
  });

  it('пустой проект — null, а не выдуманная команда', async () => {
    await project({});
    expect(await buildCommand(root)).toBeNull();
  });

  it('кандидаты называют то, что есть', async () => {
    await project({ 'package.json': { scripts: { build: 'tsc', test: 'vitest', lint: 'eslint .' } } });
    const names = await buildCandidates(root);
    expect(names).toContain('build');
    expect(names).toContain('lint');
    expect(names).toContain('test');
  });
});
