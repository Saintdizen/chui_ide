import { describe, expect, it } from 'vitest';
import { activeLanguage, needsLspRefresh, statusPatch, type StatusInputs } from '../src/renderer/core/status-state';
import type { ProjectTools } from '../src/renderer/core/project-tools';

const tools: ProjectTools = {
  root: '/p',
  packageManager: 'npm',
  pythonCommand: 'python3',
  pythonLabel: '.venv',
  pythonFromProject: true,
  nodeVersion: '20.11.0',
  scripts: [],
  hasPackageJson: true,
  tsRunner: 'tsx',
  tsRunnerFrom: 'project',
  testRunner: null,
};

function inputs(over: Partial<StatusInputs> = {}): StatusInputs {
  return {
    active: { path: '/p/a.py', languageId: 'python', readOnly: false, version: 3 },
    format: null,
    formatLabel: null,
    languageLabel: 'Python',
    languageIndent: { tabSize: 4, insertSpaces: true },
    settings: { tabSize: 2, insertSpaces: true, lspEnabled: true },
    lspChip: { text: 'Pyright', title: 'Python', tone: 'ok' } as never,
    git: { branch: 'main', changeCount: 2 },
    projectKind: { id: 'python', source: 'scan' },
    problems: { errors: 1, warnings: 2 },
    vim: null,
    macro: null,
    tools,
    configuredPython: '',
    ...over,
  };
}

describe('activeLanguage', () => {
  it('обычный файл — язык файла', () => {
    expect(activeLanguage({ path: '/p/a.py', languageId: 'python', readOnly: false, version: 1 }, null)).toBe('python');
  });

  it('картинка — языка нет: иначе в чипе висело бы plaintext у PNG', () => {
    expect(
      activeLanguage({ path: '/p/a.png', languageId: 'plaintext', readOnly: false, version: 1 }, 'image'),
    ).toBeNull();
  });
});

describe('needsLspRefresh', () => {
  it('язык сменился — спросить', () => {
    expect(needsLspRefresh(inputs(), 'typescript')).toBe(true);
  });

  it('язык тот же — не дёргаем RPC на каждое движение курсора', () => {
    expect(needsLspRefresh(inputs(), 'python')).toBe(false);
  });

  it('серверы выключены — не спрашиваем вовсе', () => {
    expect(needsLspRefresh(inputs({ settings: { tabSize: 2, insertSpaces: true, lspEnabled: false } }), null)).toBe(
      false,
    );
  });
});

describe('statusPatch', () => {
  it('отступ берётся у языка, а не из настроек: у Python четыре пробела', () => {
    const patch = statusPatch(inputs());
    expect(patch.tabSize).toBe(4);
    expect(patch.useTabs).toBe(false);
  });

  it('язык без своего отступа — общий из настроек', () => {
    const patch = statusPatch(inputs({ languageIndent: null }));
    expect(patch.tabSize).toBe(2);
  });

  it('табуляция у языка видна в полосе фактически', () => {
    expect(statusPatch(inputs({ languageIndent: { tabSize: 8, insertSpaces: false } })).useTabs).toBe(true);
  });

  it('картинка показывает формат вместо языка', () => {
    const patch = statusPatch(inputs({ format: 'image', formatLabel: 'PNG' }));
    expect(patch.language).toBe('PNG');
  });

  it('чип сервера скрыт, когда серверы выключены', () => {
    const patch = statusPatch(inputs({ settings: { tabSize: 2, insertSpaces: true, lspEnabled: false } }));
    expect(patch.lsp).toBeNull();
  });

  it('неопознанный проект — без чипа вида; опознанный — с ним', () => {
    expect(statusPatch(inputs({ projectKind: { id: 'x', source: 'none' } })).projectKindId).toBeNull();
    expect(statusPatch(inputs()).projectKindId).toBe('python');
  });

  it('окружение — по виду проекта: у Node версия, а не Python-интерпретатор', () => {
    const patch = statusPatch(
      inputs({ projectKind: { id: 'node', source: 'scan' }, configuredPython: '/usr/bin/python3' }),
    );
    expect(patch.env).toBe('node 20.11.0');
  });

  it('файла нет — пустые значения, а не падение', () => {
    const patch = statusPatch(inputs({ active: null, languageIndent: null }));
    expect(patch.readOnly).toBe(false);
    expect(patch.version).toBe(0);
    expect(patch.language).toBeNull();
  });
});
