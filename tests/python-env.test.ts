import { describe, expect, it } from 'vitest';
import {
  comparePythonVersions,
  DEFAULT_VENV_DIR,
  installPackages,
  isValidVenvName,
  parsePyvenvCfg,
  parsePythonVersion,
  pythonInterpreterLabel,
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
});

describe('venvActivatePath', () => {
  it('на POSIX — bin/activate', () => {
    expect(venvActivatePath('/p/.venv', 'linux')).toBe('/p/.venv/bin/activate');
  });

  it('на Windows — Scripts/Activate.ps1', () => {
    expect(venvActivatePath('C:/p/.venv', 'win32')).toBe('C:/p/.venv/Scripts/Activate.ps1');
  });
});

describe('venvActivateCommand', () => {
  it('source для обычного пути', () => {
    expect(venvActivateCommand('.venv', 'linux')).toBe('source .venv/bin/activate');
  });

  it('путь с пробелом оборачивается в кавычки', () => {
    expect(venvActivateCommand('my env', 'linux')).toBe('source "my env"/bin/activate');
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
