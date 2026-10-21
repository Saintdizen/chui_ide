import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { activateCommand, activationForInterpreter, venvDirOfPython } from '../src/main/python/environments';

/**
 * Активация терминала, когда окружение лежит ВНЕ проекта.
 *
 * Терминал активирует окружение сам, набирая `source …/activate`. Раньше он брал
 * только главное окружение проекта — а выбранное для проекта окружение может быть
 * где угодно (например, общее в `~/.venvs`), и тогда терминал работал бы без venv,
 * пока человек считает его активным. Здесь проверяется узнавание окружения по пути
 * интерпретатора и команда активации для него.
 *
 * Фикстура собирается системным `path`: литералы вроде `/p/.venv` на Windows дали бы
 * другой путь (`D:\p\...`), а `npm run check` гоняется и там.
 */

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** Каталог-окружение: `pyvenv.cfg` и интерпретатор — больше активации ничего не нужно. */
async function fakeVenv(parent: string, name: string, platform: string): Promise<string> {
  const venvDir = path.join(parent, name);
  const bin = path.join(venvDir, platform === 'win32' ? 'Scripts' : 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(venvDir, 'pyvenv.cfg'), 'version = 3.12.3\n', 'utf8');
  await fs.writeFile(path.join(bin, platform === 'win32' ? 'python.exe' : 'python'), '', 'utf8');
  return venvDir;
}

describe('venvDirOfPython', () => {
  it('узнаёт окружение по pyvenv.cfg рядом с bin', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-venvact-'));
    dirs.push(root);
    const venv = await fakeVenv(root, 'shared', process.platform);
    expect(venvDirOfPython(path.join(venv, 'bin', 'python'))).toBe(venv);
  });

  it('системный питон окружением не считает', () => {
    // У системного питона нет `pyvenv.cfg`, и активировать там нечего.
    expect(venvDirOfPython(path.join(path.resolve(path.sep), 'usr', 'bin', 'python3'))).toBeNull();
    expect(venvDirOfPython('python3')).toBeNull();
  });
});

describe('активация по рабочему интерпретатору', () => {
  it('окружение вне проекта активируется абсолютным путём', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-venvact-'));
    dirs.push(root);
    const project = path.join(root, 'project');
    await fs.mkdir(project, { recursive: true });
    const venv = await fakeVenv(root, 'shared', process.platform);
    const python = path.join(venv, process.platform === 'win32' ? 'Scripts' : 'bin', 'python');

    const command = activationForInterpreter(project, python, process.platform);
    // Относительный путь из `../../..` человеку ничего не говорит: он и разваливается,
    // если оболочка сменила каталог. Для окружения вне проекта — путь целиком.
    expect(command).toContain(path.basename(venv));
    expect(command).not.toContain('..');
    expect(command?.startsWith(process.platform === 'win32' ? '. ' : 'source ')).toBe(true);
  });

  it('окружение в проекте активируется относительным путём', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-venvact-'));
    dirs.push(root);
    const venv = await fakeVenv(root, '.venv', process.platform);
    const python = path.join(venv, process.platform === 'win32' ? 'Scripts' : 'bin', 'python');
    expect(activationForInterpreter(root, python, process.platform)).toBe(
      activateCommand(root, venv, process.platform),
    );
    expect(activationForInterpreter(root, python, process.platform)).toContain('.venv');
  });

  it('пустая настройка — главное окружение проекта', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-venvact-'));
    dirs.push(root);
    // Окружение по соглашению `.venv` — то, что находит поиск окружений.
    await fakeVenv(root, '.venv', process.platform);
    expect(activationForInterpreter(root, '', process.platform)).toContain('.venv');
  });

  it('окружения нет вовсе — активировать нечего', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-venvact-'));
    dirs.push(root);
    expect(activationForInterpreter(root, '', process.platform)).toBeNull();
  });
});
