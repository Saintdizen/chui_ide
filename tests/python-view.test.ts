import { describe, expect, it } from 'vitest';
import type { PythonEnvironment } from '../src/shared/python-env';
import type { ProjectTools } from '../src/renderer/core/project-tools';
import { envList, envShortLabel, envSource, envSourceLabel, envVisible } from '../src/renderer/core/python-view';

const tools: ProjectTools = {
  root: '/p',
  packageManager: 'npm',
  pythonCommand: './.venv/bin/python',
  pythonLabel: '.venv · ./.venv/bin/python',
  pythonFromProject: true,
  scripts: [],
  hasPackageJson: false,
  tsRunner: null,
};

const SYSTEM: ProjectTools = {
  ...tools,
  pythonCommand: 'python3',
  pythonLabel: 'python3 (системный)',
  pythonFromProject: false,
};

describe('envSource', () => {
  it('настройка важнее окружения проекта', () => {
    expect(envSource('/usr/bin/python3', tools)).toBe('setting');
  });

  it('пустая настройка — берём окружение проекта', () => {
    expect(envSource('  ', tools)).toBe('project');
  });

  it('ни настройки, ни окружения — системный', () => {
    expect(envSource('', SYSTEM)).toBe('system');
  });

  it('голая команда — это PATH, а не наш выбор файла', () => {
    expect(envSource('python3', tools)).toBe('system');
  });
});

describe('envSourceLabel', () => {
  it('каждому источнику — своя подпись', () => {
    expect(envSourceLabel('setting')).toContain('настроек');
    expect(envSourceLabel('project')).toContain('проекта');
    expect(envSourceLabel('system')).toContain('Системный');
  });
});

describe('envShortLabel', () => {
  it('берёт часть до «·»: в статусбаре нужен короткий путь', () => {
    expect(envShortLabel(tools)).toBe('.venv');
  });

  it('полный путь до интерпретатора показывает каталог окружения', () => {
    expect(envShortLabel({ ...tools, pythonLabel: '/home/u/p/.venv/bin/python' })).toBe('.venv');
    expect(envShortLabel({ ...tools, pythonLabel: 'C:/p/.venv/Scripts/python.exe' })).toBe('.venv');
  });

  it('подпись без «·» остаётся целиком', () => {
    expect(envShortLabel(SYSTEM)).toBe('python3 (системный)');
  });
});

describe('envVisible', () => {
  it('Python-проект показывает виджет даже с системным интерпретатором', () => {
    expect(envVisible('python', SYSTEM, '')).toBe(true);
  });

  it('Node-проект виджет не показывает', () => {
    expect(envVisible('node', SYSTEM, '')).toBe(false);
  });

  it('явная настройка показывает виджет в любом проекте', () => {
    expect(envVisible('node', SYSTEM, '/usr/bin/python3')).toBe(true);
  });

  it('найденное окружение проекта показывает виджет в любом проекте', () => {
    expect(envVisible(null, tools, '')).toBe(true);
  });
});

describe('envList', () => {
  const environment = (name: string, primary: boolean): PythonEnvironment => ({
    path: `/p/${name}`,
    relative: name,
    python: `/p/${name}/bin/python`,
    label: name,
    version: null,
    primary,
  });

  it('главное окружение — первым, порядок остальных сохранён', () => {
    const list = envList([environment('venv', false), environment('.venv', true), environment('env', false)]);
    expect(list.map((item) => item.label)).toEqual(['.venv', 'venv', 'env']);
  });
});
