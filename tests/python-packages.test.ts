import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { missingModules } from '../src/main/python/packages';

/**
 * Проверка «какие импорты не установлены» — по настоящему интерпретатору.
 *
 * Главное здесь — локальные модули проекта: `tests/examples/page.py` без
 * `__init__.py` это namespace-пакет, и подчёркивать его как отсутствующую
 * библиотеку нельзя. Раньше сборщик имён смотрел только stdlib и метаданные
 * установленных распределений, поэтому свои модули выглядели «неустановленными».
 */

const python = process.platform === 'win32' ? 'python' : 'python3';
const hasPython = spawnSync(python, ['-c', 'print(1)']).status === 0;
/** Питона в системе может не быть: тогда проверять нечего, и это не провал. */
const maybe = hasPython ? it : it.skip;

describe('missingModules', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chui-pkgs-'));
  // Установленный пакет проекта и свои модули рядом с ним.
  mkdirSync(path.join(root, 'installed_pkg'));
  writeFileSync(path.join(root, 'installed_pkg', '__init__.py'), '');
  mkdirSync(path.join(root, 'tests', 'examples'), { recursive: true });
  writeFileSync(path.join(root, 'tests', 'examples', 'page.py'), '');
  writeFileSync(path.join(root, 'app.py'), '');

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  maybe('пакет с __init__.py считается видимым', async () => {
    expect(await missingModules(root, python, ['installed_pkg'])).toEqual([]);
  });

  maybe('локальные модули и namespace-пакеты не считаются отсутствующими', async () => {
    expect(await missingModules(root, python, ['tests', 'app'])).toEqual([]);
  });

  maybe('стандартная библиотека видна', async () => {
    expect(await missingModules(root, python, ['json', 'os'])).toEqual([]);
  });

  maybe('выдуманный модуль остаётся отсутствующим', async () => {
    const missing = await missingModules(root, python, ['chui_no_such_module']);
    expect(missing).toEqual(['chui_no_such_module']);
  });
});
