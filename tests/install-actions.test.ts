import { describe, expect, it, vi } from 'vitest';
import { createInstallActions, installedMessage } from '../src/renderer/core/install-actions';
import type { ProjectTools } from '../src/renderer/core/project-tools';
import type { RunTarget } from '../src/renderer/core/run-config';
import type { RpcClient } from '../src/renderer/core/rpc';
import type { PythonEnvironment } from '../src/shared/python-env';

const env: PythonEnvironment = {
  path: '/p/.venv',
  relative: '.venv',
  python: '/p/.venv/bin/python',
  label: '.venv',
  version: '3.12',
  primary: true,
};

const tools: ProjectTools = {
  root: '/p',
  packageManager: 'npm',
  pythonCommand: 'python3',
  pythonLabel: 'python3',
  pythonFromProject: false,
  nodeVersion: null,
  scripts: [],
  hasPackageJson: true,
  tsRunner: null,
  tsRunnerFrom: null,
  testRunner: null,
};

/** RPC-шпион: запоминает вызовы и отдаёт заранее заданные ответы по имени метода. */
function makeRpc(answers: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const rpc = {
    request: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params });
      return answers[method];
    }),
    stream: vi.fn(async (method: string, params: unknown, onChunk: (chunk: string) => void) => {
      calls.push({ method, params });
      onChunk('ok');
      return answers[method];
    }),
  } as unknown as RpcClient;
  return { rpc, calls };
}

function setup(overrides: Partial<Parameters<typeof createInstallActions>[0]> = {}) {
  const toasts: Array<[string, string | undefined]> = [];
  const terminals: RunTarget[] = [];
  const refreshed: number[] = [];
  const rpcBundle = makeRpc({
    'python.install': { installed: ['numpy'] },
    'python.venvAt': { environment: env, candidates: [], reason: null },
    'dialog.pickFolder': { path: '/p/.venv' },
    'settings.update': {},
    ...(overrides as { answers?: Record<string, unknown> }).answers,
  });
  const actions = createInstallActions({
    rpc: rpcBundle.rpc,
    toast: (message, kind) => toasts.push([message, kind]),
    settings: () => ({ run: { pythonPath: 'python3', pythonByRoot: {} } }),
    root: () => '/p',
    projectTools: () => tools,
    runInTerminal: async (target) => {
      terminals.push(target);
    },
    refreshImports: () => refreshed.push(1),
    onInterpreterChanged: () => undefined,
    ...overrides,
  });
  return { actions, toasts, terminals, refreshed, calls: rpcBundle.calls };
}

describe('installedMessage', () => {
  it('называет поставленное поимённо', () => {
    expect(installedMessage(['numpy', 'pandas'], 'Нечего ставить')).toBe('Готово: numpy, pandas');
  });

  it('пустой список — готовая фраза вызывающего, а не «Готово: »', () => {
    expect(installedMessage([], 'Нечего ставить')).toBe('Нечего ставить');
  });
});

describe('installPythonPackages', () => {
  it('ставит через python.install и перепроверяет импорты', async () => {
    const { actions, refreshed, calls } = setup();
    await actions.installPythonPackages(['numpy']);
    expect(calls.map((call) => call.method)).toEqual(['python.install']);
    expect(calls[0]?.params).toEqual({ packages: ['numpy'], requirements: false });
    expect(refreshed).toHaveLength(1);
  });

  it('requirements зовёт с пустым списком и флагом', async () => {
    const { actions, calls } = setup();
    await actions.installRequirements();
    expect(calls[0]?.params).toEqual({ packages: [], requirements: true });
  });

  it('отказ pip показывается ошибкой, а импорты не перепроверяются', async () => {
    const { actions, toasts, refreshed } = setup({
      rpc: {
        request: vi.fn(),
        stream: vi.fn(async () => {
          throw new Error('pip: нет сети');
        }),
      } as unknown as RpcClient,
    });
    await actions.installPythonPackages(['numpy']);
    expect(toasts.at(-1)).toEqual(['pip: нет сети', 'error']);
    expect(refreshed).toHaveLength(0);
  });

  it('без проекта ничего не ставит и говорит об этом', async () => {
    const { actions, toasts, calls } = setup({ root: () => null });
    await actions.installPythonPackages(['numpy']);
    expect(calls).toHaveLength(0);
    expect(toasts).toEqual([['Проект не открыт', 'error']]);
  });
});

describe('installNodePackages', () => {
  it('идёт в терминал, а не через RPC', async () => {
    const { actions, terminals, calls } = setup();
    await actions.installNodePackages(['zod']);
    expect(terminals).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });
});

describe('setProjectInterpreter', () => {
  it('запоминает путь за корнем проекта', async () => {
    const { actions, calls } = setup();
    await actions.setProjectInterpreter('/p/.venv/bin/python');
    expect(calls[0]?.params).toEqual({ run: { pythonByRoot: { '/p': '/p/.venv/bin/python' } } });
  });

  it('пусто — ключ удаляется, а не пишется пустой строкой', async () => {
    const { actions, calls } = setup({
      settings: () => ({ run: { pythonPath: 'python3', pythonByRoot: { '/p': '/old/python' } } }),
    });
    await actions.setProjectInterpreter('');
    expect(calls[0]?.params).toEqual({ run: { pythonByRoot: {} } });
  });
});

describe('pickExistingVenv', () => {
  it('берёт найденное окружение для проекта', async () => {
    const { actions, toasts, calls } = setup();
    await actions.pickExistingVenv();
    expect(calls.map((call) => call.method)).toEqual(['dialog.pickFolder', 'python.venvAt', 'settings.update']);
    expect(toasts.at(-1)).toEqual(['Интерпретатор: .venv', undefined]);
  });

  it('папка не подошла — причина человеку, интерпретатор не меняется', async () => {
    const { actions, toasts, calls } = setup({
      rpc: {
        request: vi.fn(async (method: string) => {
          if (method === 'dialog.pickFolder') return { path: '/p/src' };
          return { environment: null, candidates: [], reason: 'Это не виртуальное окружение' };
        }),
      } as unknown as RpcClient,
    });
    await actions.pickExistingVenv();
    expect(toasts.at(-1)).toEqual(['Это не виртуальное окружение', 'error']);
    expect(calls).toHaveLength(0);
  });

  it('диалог отменён — тишина, ничего не пишем', async () => {
    const { actions, toasts, calls } = setup({
      rpc: { request: vi.fn(async () => ({ path: '' })) } as unknown as RpcClient,
    });
    await actions.pickExistingVenv();
    expect(calls).toHaveLength(0);
    expect(toasts).toHaveLength(0);
  });
});
