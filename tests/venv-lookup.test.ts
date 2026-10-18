import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lookupVenv } from '../src/main/python/environments';

/**
 * Окружение по папке, которую указал человек.
 *
 * Человеку нужно взять окружение, созданное РАНЬШЕ — в другом проекте или общее на
 * несколько, — а поиск окружений в проекте (`findEnvironments`) такое не видит:
 * оно лежит вне корня. Поэтому папку выбирают руками, и главное здесь — не принять
 * за окружение что попало: соседняя папка с `bin` (системный питон) активировать
 * нечего, и проект остался бы на прежнем интерпретаторе без всякого объяснения.
 *
 * Фикстура собирается системным `path`: литералы вида `/p/.venv` на Windows дали бы
 * другой путь, а `npm run check` гоняется и там.
 */

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** Временный каталог под фикстуру. */
async function sandbox(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-venv-at-'));
  dirs.push(dir);
  return dir;
}

/** Настоящее на вид окружение: `pyvenv.cfg` и интерпретатор на своём месте. */
async function makeVenv(parent: string, name: string, version = '3.12.3'): Promise<string> {
  const venvDir = path.join(parent, name);
  const bin = path.join(venvDir, process.platform === 'win32' ? 'Scripts' : 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(venvDir, 'pyvenv.cfg'), `version = ${version}\n`, 'utf8');
  await fs.writeFile(path.join(bin, process.platform === 'win32' ? 'python.exe' : 'python'), '', 'utf8');
  return venvDir;
}

describe('окружение по выбранной папке', () => {
  it('находит окружение вне проекта и показывает путь с ~', async () => {
    const home = await sandbox();
    const project = path.join(home, 'projects', 'demo');
    await fs.mkdir(project, { recursive: true });
    const venv = await makeVenv(path.join(home, '.venvs'), 'shared');

    const found = await lookupVenv(venv, project, home, process.platform);
    expect(found.environment).not.toBeNull();
    expect(found.environment?.path).toBe(venv);
    expect(found.environment?.version).toBe('3.12.3');
    expect(found.environment?.python).toBe(
      path.join(
        venv,
        process.platform === 'win32' ? 'Scripts' : 'bin',
        process.platform === 'win32' ? 'python.exe' : 'python',
      ),
    );
    // Вне проекта — путь с `~`, а не `../../../.venvs/shared`.
    expect(found.environment?.label).toBe('~/.venvs/shared');
    // Основным внешнее окружение не становится: поиск в проекте его не увидит.
    expect(found.environment?.primary).toBe(false);
  });

  it('окружение внутри проекта — основное, путь от корня', async () => {
    const home = await sandbox();
    const project = path.join(home, 'demo');
    const venv = await makeVenv(project, '.venv');

    const found = await lookupVenv(venv, project, home, process.platform);
    expect(found.environment?.primary).toBe(true);
    expect(found.environment?.label).toBe('.venv');
  });

  it('указали общую папку с одним окружением — берём его', async () => {
    const home = await sandbox();
    const project = path.join(home, 'demo');
    await fs.mkdir(project, { recursive: true });
    const shared = path.join(home, '.venvs');
    const venv = await makeVenv(shared, 'only-one');

    const found = await lookupVenv(shared, project, home, process.platform);
    expect(found.environment?.path).toBe(venv);
  });

  it('в общей папке несколько окружений — выбирать должен человек', async () => {
    const home = await sandbox();
    const project = path.join(home, 'demo');
    await fs.mkdir(project, { recursive: true });
    const shared = path.join(home, '.venvs');
    await makeVenv(shared, 'one', '3.11.0');
    await makeVenv(shared, 'two', '3.12.0');

    const found = await lookupVenv(shared, project, home, process.platform);
    expect(found.environment).toBeNull();
    expect(found.candidates).toHaveLength(2);
    expect(found.reason).toContain('несколько окружений');
  });

  it('папка без pyvenv.cfg — не окружение, и это сказано словами', async () => {
    const home = await sandbox();
    const project = path.join(home, 'demo');
    await fs.mkdir(project, { recursive: true });
    // Похоже на окружение: есть bin/python, но нет pyvenv.cfg — так выглядит
    // системный питон, а не venv.
    const fake = path.join(home, 'not-a-venv');
    await fs.mkdir(path.join(fake, 'bin'), { recursive: true });
    await fs.writeFile(path.join(fake, 'bin', 'python'), '', 'utf8');

    const found = await lookupVenv(fake, project, home, process.platform);
    expect(found.environment).toBeNull();
    expect(found.candidates).toEqual([]);
    expect(found.reason).toContain('pyvenv.cfg');
  });

  it('папки нет — причина называет её', async () => {
    const home = await sandbox();
    const project = path.join(home, 'demo');
    await fs.mkdir(project, { recursive: true });
    const missing = path.join(home, '.venvs', 'gone');

    const found = await lookupVenv(missing, project, home, process.platform);
    expect(found.environment).toBeNull();
    expect(found.reason).toContain('не найдена');
  });

  it('без открытого проекта внешнее окружение всё равно находится', async () => {
    const home = await sandbox();
    const venv = await makeVenv(path.join(home, '.venvs'), 'shared');
    const found = await lookupVenv(venv, null, home, process.platform);
    expect(found.environment?.path).toBe(venv);
    expect(found.environment?.primary).toBe(false);
  });
});
