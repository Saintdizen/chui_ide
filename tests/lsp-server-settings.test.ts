import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LspServerConfig } from '../src/shared/api';

/**
 * Поля сервера LSP, которых раньше не было: `extraFolders` и `priority`.
 *
 * Оба — про выбор и область сервера: приоритет решает, кто из нескольких
 * серверов языка поднимется первым, лишние папки — что сервер увидит в
 * `workspaceFolders`. Файл настроек правит человек, поэтому и проверяется стык:
 * мусор не ломает соседей, а записанное переживает перезапуск.
 *
 * Заодно здесь сторожит `requestTimeoutMs`: он был в настройках, читался
 * сервисом, но `sanitizeLsp` его терял — значение молча не работало.
 */

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
}));

const { SettingsStore } = await import('../src/main/settings');

const dirs: string[] = [];

async function storeWith(lsp: unknown): Promise<InstanceType<typeof SettingsStore>> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-lsp-settings-'));
  dirs.push(dir);
  const file = path.join(dir, 'settings.json');
  await fs.writeFile(file, JSON.stringify({ lsp }), 'utf8');
  return new SettingsStore(file);
}

const pythonServer = (extra: Record<string, unknown> = {}): LspServerConfig =>
  ({
    language: 'python',
    command: 'pyright-langserver',
    args: ['--stdio'],
    enabled: true,
    ...extra,
  }) as LspServerConfig;

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('lsp.servers: доп. папки и приоритет', () => {
  it('extraFolders и priority переживают перезапуск', async () => {
    const store = await storeWith({ servers: [pythonServer({ extraFolders: ['packages/api'], priority: 5 })] });
    const again = new SettingsStore(store.file());
    const server = again.get().lsp.servers[0]!;
    expect(server.extraFolders).toEqual(['packages/api']);
    expect(server.priority).toBe(5);
  });

  it('папки чистятся: пробелы по краям уходят, пустые и повторы тоже', async () => {
    const store = await storeWith({
      servers: [pythonServer({ extraFolders: [' packages/api ', '', 'packages/api', 42, null] })],
    });
    expect(store.get().lsp.servers[0]!.extraFolders).toEqual(['packages/api']);
  });

  it('папки не списком — поле не появляется, сервер остаётся', async () => {
    const store = await storeWith({ servers: [pythonServer({ extraFolders: 'packages/api' })] });
    const server = store.get().lsp.servers[0]!;
    expect(server.command).toBe('pyright-langserver');
    expect(server.extraFolders).toBeUndefined();
  });

  it('приоритет-мусор — как будто его нет (не NaN в сравнении)', async () => {
    const store = await storeWith({ servers: [pythonServer({ priority: 'высокий' })] });
    expect(store.get().lsp.servers[0]!.priority).toBeUndefined();
  });

  it('ноль и отрицательный приоритет — законные значения', async () => {
    const store = await storeWith({ servers: [pythonServer({ priority: 0 })] });
    expect(store.get().lsp.servers[0]!.priority).toBe(0);
    store.update({ lsp: { servers: [pythonServer({ priority: -3 })] } });
    expect(store.get().lsp.servers[0]!.priority).toBe(-3);
  });

  it('правка из формы не теряет чужие серверы и не делит массив с снимком', async () => {
    const store = await storeWith({ servers: [pythonServer(), pythonServer({ language: 'go' })] });
    const before = store.get().lsp.servers;
    store.update({ lsp: { servers: [{ ...before[0]!, extraFolders: ['vendor'] }, before[1]!] } });
    expect(before[0]!.extraFolders).toBeUndefined();
    expect(store.get().lsp.servers.map((server) => server.language)).toEqual(['python', 'go']);
  });

  it('requestTimeoutMs доходит до сервиса, а не теряется по дороге', async () => {
    const store = await storeWith({ requestTimeoutMs: 12_000 });
    expect(store.get().lsp.requestTimeoutMs).toBe(12_000);
  });
});
