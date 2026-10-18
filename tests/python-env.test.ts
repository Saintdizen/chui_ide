import { describe, expect, it } from 'vitest';
import {
  comparePythonVersions,
  DEFAULT_VENV_DIR,
  HOME_VENVS_DIR,
  installPackages,
  isAbsolutePath,
  isValidVenvName,
  parsePyvenvCfg,
  parsePythonVersion,
  pythonInterpreterLabel,
  resolveVenvTarget,
  shortenHomePath,
  VENV_LOCATIONS,
  venvActivateCommand,
  venvActivatePath,
  venvPythonPath,
} from '../src/shared/python-env';

describe('venvPythonPath', () => {
  it('на POSIX — bin/python', () => {
    expect(venvPythonPath('/p/.venv', 'linux')).toBe('/p/.venv/bin/python');
  });

  it('на Windows — Scripts/python.exe', () => {
    expect(venvPythonPath('C:/p/.venv', 'win32')).toBe('C:/p/.venv/Scripts/python.exe');
  });

  // Каталог из `path.join` приходит на Windows с обратными слэшами: подпуть должен
  // идти тем же разделителем, а не мешать оба в одной строке (`...\\shared/Scripts`).
  it('на Windows native-путь остаётся целиком с обратными слэшами', () => {
    expect(venvPythonPath('C:\\p\\.venv', 'win32')).toBe('C:\\p\\.venv\\Scripts\\python.exe');
  });

  it('хвостовой разделитель не удваивается', () => {
    expect(venvPythonPath('/p/.venv/', 'linux')).toBe('/p/.venv/bin/python');
  });
});

describe('venvActivatePath', () => {
  it('на POSIX — bin/activate', () => {
    expect(venvActivatePath('/p/.venv', 'linux')).toBe('/p/.venv/bin/activate');
  });

  it('на Windows — Scripts/Activate.ps1', () => {
    expect(venvActivatePath('C:/p/.venv', 'win32')).toBe('C:/p/.venv/Scripts/Activate.ps1');
  });

  it('хвостовой разделитель не удваивается', () => {
    expect(venvActivatePath('/p/.venv/', 'linux')).toBe('/p/.venv/bin/activate');
  });
});

describe('venvActivateCommand', () => {
  it('source для обычного пути', () => {
    expect(venvActivateCommand('.venv', 'linux')).toBe('source .venv/bin/activate');
  });

  // Кавычки — на целом пути к скрипту, а не на каталоге: иначе разделитель подпути
  // оказался бы за кавычкой (`"my env"/bin` → `"my env\bin`).
  it('путь с пробелом оборачивается в кавычки', () => {
    expect(venvActivateCommand('my env', 'linux')).toBe('source "my env/bin/activate"');
  });

  it('на Windows путь с пробелом в кавычках не ломается', () => {
    expect(venvActivateCommand('C:\\p\\my env', 'win32')).toBe('. "C:\\p\\my env\\Scripts\\Activate.ps1"');
  });

  it('вложенное окружение — путь целиком', () => {
    expect(venvActivateCommand('backend/.venv', 'linux')).toBe('source backend/.venv/bin/activate');
  });

  it('на Windows активируем PowerShell-скрипт', () => {
    expect(venvActivateCommand('.venv', 'win32')).toBe('. .venv/Scripts/Activate.ps1');
  });
});

describe('parsePyvenvCfg', () => {
  it('достаёт версию и базовый интерпретатор', () => {
    const text = ['home = /usr/bin', 'include-system-site-packages = false', 'version = 3.12.3'].join('\n');
    expect(parsePyvenvCfg(text)).toEqual({ version: '3.12.3', base: '/usr/bin' });
  });

  it('предпочитает base-executable первой строке home', () => {
    const text = ['home = /usr/bin', 'base-executable = /usr/bin/python3.11', 'version = 3.11.9'].join('\n');
    expect(parsePyvenvCfg(text).base).toBe('/usr/bin/python3.11');
  });

  it('пустой и неполный файл не роняют разбор', () => {
    expect(parsePyvenvCfg('')).toEqual({ version: null, base: null });
    expect(parsePyvenvCfg('version = 3.10.0')).toEqual({ version: '3.10.0', base: null });
  });
});

describe('installPackages', () => {
  it('уровни дают свои наборы', () => {
    expect(installPackages('empty')).toEqual([]);
    expect(installPackages('pytest')).toContain('pytest');
    expect(installPackages('full')).toContain('python-lsp-server');
  });

  it('полное окружение включает линтеры для pylsp', () => {
    // Базовая установка python-lsp-server не проверяет код: без плагинов сервер
    // молчит. Линтеры должны стоять в наборе, иначе «подсказки» не работают.
    const full = installPackages('full');
    expect(full).toContain('pyflakes');
    expect(full).toContain('pycodestyle');
  });

  it('неизвестный уровень — пусто, без догадок', () => {
    expect(installPackages('что-то')).toEqual([]);
  });
});

describe('isValidVenvName', () => {
  it('обычные имена проходят', () => {
    expect(isValidVenvName('.venv')).toBe(true);
    expect(isValidVenvName('venv-py312')).toBe(true);
    expect(isValidVenvName(DEFAULT_VENV_DIR)).toBe(true);
  });

  it('путь и пустое имя — нет', () => {
    expect(isValidVenvName('')).toBe(false);
    expect(isValidVenvName('   ')).toBe(false);
    expect(isValidVenvName('sub/.venv')).toBe(false);
    expect(isValidVenvName('sub\\venv')).toBe(false);
  });

  it('запрещённые символы — нет', () => {
    expect(isValidVenvName('ve*nv')).toBe(false);
    expect(isValidVenvName('venv|x')).toBe(false);
  });
});

describe('место создания окружения', () => {
  const root = '/work/demo';
  const home = '/home/user';

  it('по умолчанию создаётся в проекте, как было до выбора места', () => {
    expect(resolveVenvTarget({ root, home })).toEqual({ dir: '/work/demo/.venv', label: DEFAULT_VENV_DIR });
    expect(resolveVenvTarget({ root, home, location: 'project', name: 'venv42' })).toEqual({
      dir: '/work/demo/venv42',
      label: 'venv42',
    });
  });

  it('в домашнем каталоге — в ~/.venvs, и подпись с ~', () => {
    const target = resolveVenvTarget({ root, home, location: 'home', name: 'общий' });
    expect(target).toEqual({ dir: `/home/user/${HOME_VENVS_DIR}/общий`, label: '~/.venvs/общий' });
  });

  it('своя папка: абсолютный путь берётся как есть', () => {
    const target = resolveVenvTarget({ root, home, location: 'custom', path: '/opt/venvs/demo' });
    expect(target).toEqual({ dir: '/opt/venvs/demo', label: '/opt/venvs/demo' });
  });

  it('своя папка: ~ раскрывается, путь в домашнем каталоге показывается с ~', () => {
    const target = resolveVenvTarget({ root, home, location: 'custom', path: '~/venvs/общий' });
    expect(target).toEqual({ dir: '/home/user/venvs/общий', label: '~/venvs/общий' });
  });

  it('своя папка: относительный путь считается от проекта', () => {
    expect(resolveVenvTarget({ root, home, location: 'custom', path: '../shared-env' })).toEqual({
      dir: '/work/demo/../shared-env',
      label: '/work/demo/../shared-env',
    });
  });

  it('пустой путь в своей папке — ошибка, а не окружение вслепую', () => {
    const target = resolveVenvTarget({ root, home, location: 'custom', path: '   ' });
    expect('error' in target && target.error).toContain('папку');
  });

  it('плохое имя в проекте и в ~/.venvs — ошибка', () => {
    for (const location of ['project', 'home'] as const) {
      const target = resolveVenvTarget({ root, home, location, name: 'sub/venv' });
      expect('error' in target).toBe(true);
    }
  });

  it('в списке мест есть все три варианта', () => {
    expect(VENV_LOCATIONS.map((option) => option.id)).toEqual(['project', 'home', 'custom']);
  });

  it('absolute path распознаётся на обеих платформах', () => {
    expect(isAbsolutePath('/opt/venvs')).toBe(true);
    expect(isAbsolutePath('C:\\venvs')).toBe(true);
    expect(isAbsolutePath('venvs')).toBe(false);
    expect(isAbsolutePath('.venv')).toBe(false);
  });

  it('домашний каталог показывается как ~, чужой путь — как есть', () => {
    expect(shortenHomePath('/home/user/.venvs/a', home)).toBe('~/.venvs/a');
    expect(shortenHomePath(home, home)).toBe('~');
    expect(shortenHomePath('/opt/venvs/a', home)).toBe('/opt/venvs/a');
  });
});

describe('parsePythonVersion', () => {
  it('достаёт версию из вывода `--version`', () => {
    expect(parsePythonVersion('Python 3.14.0')).toBe('3.14.0');
    expect(parsePythonVersion('Python 3.12.3\n')).toBe('3.12.3');
  });

  it('разбирает ответ без микро-версии', () => {
    expect(parsePythonVersion('Python 3.13')).toBe('3.13');
  });

  it('не-питоновый вывод — null, без догадок', () => {
    expect(parsePythonVersion('gcc version 13')).toBeNull();
    expect(parsePythonVersion('')).toBeNull();
  });
});

describe('pythonInterpreterLabel', () => {
  it('показывает major.minor даже при полной версии', () => {
    expect(pythonInterpreterLabel('3.14.0')).toBe('Python 3.14');
  });

  it('неполная версия остаётся как есть', () => {
    expect(pythonInterpreterLabel('3')).toBe('Python 3');
  });
});

describe('comparePythonVersions', () => {
  it('сравнивает по числовым частям, а не по строке', () => {
    expect(comparePythonVersions('3.9.0', '3.10.0')).toBeLessThan(0);
    expect(comparePythonVersions('3.14.0', '3.9.0')).toBeGreaterThan(0);
  });

  it('разная длина частей не путает порядок', () => {
    expect(comparePythonVersions('3.14', '3.14.0')).toBe(0);
    expect(comparePythonVersions('3.14.1', '3.14')).toBeGreaterThan(0);
  });

  it('сортировка по убыванию — от новой к старой', () => {
    const sorted = ['3.9.0', '3.14.0', '3.12.1'].sort((a, b) => comparePythonVersions(b, a));
    expect(sorted).toEqual(['3.14.0', '3.12.1', '3.9.0']);
  });
});
