import { describe, expect, it } from 'vitest';
import type { ProjectTools } from '../src/renderer/core/project-tools';
import { envWidgetLabel, nodeEnvShortLabel } from '../src/renderer/core/env-widget';

const base: ProjectTools = {
  root: '/p',
  packageManager: 'npm',
  pythonCommand: './.venv/bin/python',
  pythonLabel: '.venv · ./.venv/bin/python',
  pythonFromProject: true,
  nodeVersion: '20.11.0',
  scripts: [],
  hasPackageJson: true,
  tsRunner: null,
  tsRunnerFrom: null,
  testRunner: null,
};

describe('envWidgetLabel', () => {
  it('Node-проект показывает Node, а не чужой Python', () => {
    expect(envWidgetLabel('node', base, '')).toBe('node 20.11.0');
    expect(envWidgetLabel('node', base, '/usr/bin/python3')).toBe('node 20.11.0');
  });

  it('Python-проект показывает интерпретатор', () => {
    expect(envWidgetLabel('python', base, '')).toBe('.venv');
  });

  it('проект не открыт — виджета нет', () => {
    expect(envWidgetLabel('python', { ...base, root: null }, '')).toBeNull();
  });
});

describe('nodeEnvShortLabel', () => {
  it('без версии Node берём менеджер пакетов', () => {
    expect(nodeEnvShortLabel({ ...base, nodeVersion: null })).toBe('npm');
  });

  it('ни версии, ни package.json — скрыт', () => {
    expect(nodeEnvShortLabel({ ...base, nodeVersion: null, hasPackageJson: false })).toBeNull();
  });
});
