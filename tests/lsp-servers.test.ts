import { describe, expect, it, vi } from 'vitest';
import { createLspServers, missingServerHint, prewarmLanguages } from '../src/renderer/core/lsp-servers';
import type { RpcClient } from '../src/renderer/core/rpc';
import type { LspServerConfig } from '../src/shared/api';
import type { ProjectScan } from '../src/shared/project-scan';

const python: LspServerConfig = { language: 'python', command: 'pylsp', args: [], enabled: true };
const ts: LspServerConfig = { language: 'typescript', command: 'tsserver', args: [], enabled: true };

const scan = { root: '/p', kind: { id: 'python', label: 'Python' }, languages: [] } as unknown as ProjectScan;

function setup(answers: Record<string, unknown> = {}, lsp = { enabled: true, servers: [] as LspServerConfig[] }) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const toasts: Array<{ message: string; action?: { label: string } }> = [];
  const rpc = {
    request: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params });
      return answers[method];
    }),
  } as unknown as RpcClient;
  const servers = createLspServers({
    rpc,
    settings: () => ({ lsp }),
    root: () => '/p',
    scan: () => scan,
    documents: () => [{ path: '/p/a.py', languageId: 'python', value: 'x = 1' }],
    toast: (message, _kind, action) => toasts.push({ message, action }),
    openLspSettings: () => undefined,
    onStatus: () => undefined,
  });
  return { servers, calls, toasts };
}

describe('prewarmLanguages', () => {
  it('без карты греть нечего', () => {
    expect(prewarmLanguages(null)).toEqual([]);
  });
});

describe('missingServerHint', () => {
  it('молчит, когда сервер для языка проекта есть', () => {
    expect(missingServerHint('python', [python])).toBeNull();
  });

  it('говорит про Python отдельной фразой', () => {
    expect(missingServerHint('python', [ts])).toContain('Python');
  });

  it('о незнакомом виде проекта молчит', () => {
    expect(missingServerHint('rust', [])).toBeNull();
  });
});

describe('ensure: гонка на старте', () => {
  it('три одновременных вызова дают ОДИН запрос и одно уведомление', async () => {
    const { servers, calls, toasts } = setup({ 'lsp.detect': [python], 'settings.update': {} });
    await Promise.all([servers.ensure(), servers.ensure(), servers.ensure()]);
    expect(calls.filter((call) => call.method === 'lsp.detect')).toHaveLength(1);
    expect(toasts.filter((toast) => toast.message.startsWith('Языковые серверы подключены'))).toHaveLength(1);
  });

  it('пока прогон идёт, isRunning правда; после — нет', async () => {
    const { servers } = setup({ 'lsp.detect': [], 'settings.update': {} });
    const first = servers.ensure();
    expect(servers.isRunning()).toBe(true);
    await first;
    expect(servers.isRunning()).toBe(false);
  });

  it('о новых языках говорит один раз, повтор не шумит', async () => {
    const { servers, toasts } = setup({ 'lsp.detect': [python], 'settings.update': {} });
    await servers.ensure();
    await servers.ensure();
    expect(toasts.filter((toast) => toast.message.startsWith('Языковые серверы подключены'))).toHaveLength(1);
  });
});

describe('ensure: выключенные подсказки', () => {
  it('серверы есть, тумблер выключен — говорим и даём кнопку', async () => {
    const { servers, calls, toasts } = setup({ 'lsp.detect': [python] }, { enabled: false, servers: [] });
    await servers.ensure();
    expect(calls.map((call) => call.method)).toEqual(['lsp.detect']);
    expect(toasts[0]?.message).toBe('Языковые серверы установлены, но выключены в настройках');
    expect(toasts[0]?.action?.label).toBe('Открыть');
  });

  it('серверов нет — не сказали, чтобы сказать позже, когда появятся', async () => {
    const { servers, toasts } = setup({ 'lsp.detect': [] }, { enabled: false, servers: [] });
    await servers.ensure();
    expect(toasts).toHaveLength(0);
    // Появились — теперь скажем.
    const second = setup({ 'lsp.detect': [python] }, { enabled: false, servers: [] });
    await second.servers.ensure();
    expect(second.toasts).toHaveLength(1);
  });

  it('выключено — настройки не правим', async () => {
    const { servers, calls } = setup({ 'lsp.detect': [python] }, { enabled: false, servers: [] });
    await servers.ensure();
    expect(calls.some((call) => call.method === 'settings.update')).toBe(false);
  });
});

describe('restart', () => {
  it('перезапускает и заново открывает документы', async () => {
    const { servers, calls } = setup({
      'lsp.restart': { running: [], servers: [], failed: [] },
      'lsp.open': undefined,
    });
    await servers.restart();
    expect(calls.map((call) => call.method)).toEqual(['lsp.restart', 'lsp.open']);
    expect(calls[1]?.params).toEqual({ path: '/p/a.py', languageId: 'python', text: 'x = 1' });
  });

  it('выключено — не перезапускаем вовсе', async () => {
    const { servers, calls } = setup({}, { enabled: false, servers: [] });
    await servers.restart();
    expect(calls).toHaveLength(0);
  });

  it('выключили, пока ехал ответ, — документы не открываем', async () => {
    let enabled = true;
    const calls: string[] = [];
    const rpc = {
      request: vi.fn(async (method: string) => {
        calls.push(method);
        if (method === 'lsp.restart') enabled = false;
        return { running: [], servers: [], failed: [] };
      }),
    } as unknown as RpcClient;
    const servers = createLspServers({
      rpc,
      settings: () => ({ lsp: { enabled, servers: [] } }),
      root: () => '/p',
      scan: () => scan,
      documents: () => [{ path: '/p/a.py', languageId: 'python', value: '' }],
      toast: () => undefined,
      openLspSettings: () => undefined,
      onStatus: () => undefined,
    });
    await servers.restart();
    expect(calls).toEqual(['lsp.restart']);
  });
});

describe('prewarm', () => {
  it('греет языки проекта', async () => {
    const map = { ...scan, languages: [{ id: 'python' }] } as unknown as ProjectScan;
    const calls: Array<{ method: string; params: unknown }> = [];
    let prewarmed = 0;
    const servers = createLspServers({
      rpc: {
        request: vi.fn(async (method: string, params: unknown) => {
          calls.push({ method, params });
          return undefined;
        }),
      } as unknown as RpcClient,
      settings: () => ({ lsp: { enabled: true, servers: [] } }),
      root: () => '/p',
      scan: () => map,
      documents: () => [],
      toast: () => undefined,
      openLspSettings: () => undefined,
      onStatus: () => undefined,
      onPrewarmed: () => (prewarmed += 1),
    });
    await servers.prewarm();
    expect(calls[0]?.method).toBe('lsp.prewarm');
    expect(prewarmed).toBe(1);
  });

  it('карта от другого корня — молчим и не греем', async () => {
    const foreign = { ...scan, root: '/other', languages: [{ id: 'python' }] } as unknown as ProjectScan;
    const calls: string[] = [];
    const servers = createLspServers({
      rpc: {
        request: vi.fn(async (method: string) => {
          calls.push(method);
          return undefined;
        }),
      } as unknown as RpcClient,
      settings: () => ({ lsp: { enabled: true, servers: [] } }),
      root: () => '/p',
      scan: () => foreign,
      documents: () => [],
      toast: () => undefined,
      openLspSettings: () => undefined,
      onStatus: () => undefined,
    });
    await servers.prewarm();
    expect(calls).toHaveLength(0);
  });
});
