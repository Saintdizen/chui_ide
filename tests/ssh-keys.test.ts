import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Открытые SSH-ключи для настроек git (`main/git/ssh-keys.ts`).
 *
 * Модуль читает `~/.ssh` — поэтому тест подменяет домашний каталог временным и
 * собирает в нём файлы. Настоящий дом не трогается, и результат не зависит от того,
 * какие ключи есть у того, кто запускает тесты.
 *
 * Отпечаток зовёт `ssh-keygen`: его нет в ровном окружении (и не должен быть),
 * поэтому отказ утилиты — штатный случай, и проверяется именно он.
 */

let home = '';

afterEach(async () => {
  if (home) await fs.rm(home, { recursive: true, force: true });
  home = '';
  vi.resetModules();
  vi.doUnmock('../src/main/tool');
});

/** Временный домашний каталог с указанными файлами в `.ssh`. */
async function fakeHome(files: Record<string, string>): Promise<void> {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-ssh-'));
  const dir = path.join(home, '.ssh');
  await fs.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content);
  }
  vi.doMock('node:os', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:os')>();
    return { ...original, homedir: () => home, default: { ...original, homedir: () => home } };
  });
}

const listSshKeys = async () => (await import('../src/main/git/ssh-keys')).listSshKeys();

const ED25519 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyData user@host';

describe('список открытых ключей', () => {
  it('берёт только .pub и разбирает тип с комментарием', async () => {
    await fakeHome({
      'id_ed25519.pub': ED25519,
      id_ed25519: 'СТРОКА БЕЗ РАЗБОРА',
      known_hosts: 'example.com ssh-ed25519 AAAA',
      'id_rsa.pub': 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQAB work@laptop',
    });

    const keys = await listSshKeys();

    expect(keys.map((key) => path.basename(key.path)).sort()).toEqual(['id_ed25519.pub', 'id_rsa.pub']);
    expect(keys.find((key) => key.path.endsWith('id_ed25519.pub'))?.comment).toBe('user@host');
    expect(keys.find((key) => key.path.endsWith('id_rsa.pub'))?.type).toBe('ssh-rsa');
  });

  it('приватный ключ в список не попадает, даже без расширения', async () => {
    // Показ приватного ключа в интерфейсе — утечка; фильтр по `.pub` это держит.
    await fakeHome({ id_ed25519: ED25519 });

    expect(await listSshKeys()).toEqual([]);
  });

  it('битый .pub пропускается', async () => {
    await fakeHome({ 'broken.pub': 'это не ключ', 'good.pub': ED25519 });

    const keys = await listSshKeys();

    expect(keys.map((key) => path.basename(key.path))).toEqual(['good.pub']);
  });

  it('нет каталога .ssh — пустой список, без ошибки', async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-ssh-'));
    vi.doMock('node:os', async (importOriginal) => {
      const original = await importOriginal<typeof import('node:os')>();
      return { ...original, homedir: () => home, default: { ...original, homedir: () => home } };
    });

    await expect(listSshKeys()).resolves.toEqual([]);
  });

  it('ключи идут по алфавиту: так список не «прыгает» от запуска к запуску', async () => {
    await fakeHome({ 'z.pub': ED25519, 'a.pub': ED25519, 'm.pub': ED25519 });

    const keys = await listSshKeys();

    expect(keys.map((key) => path.basename(key.path))).toEqual(['a.pub', 'm.pub', 'z.pub']);
  });

  it('без ssh-keygen отпечаток пустой, а ключ всё равно в списке', async () => {
    vi.doMock('../src/main/tool', () => ({
      runTool: async () => ({ ok: false, stdout: '', stderr: 'нет утилиты' }),
    }));
    await fakeHome({ 'id.pub': ED25519 });

    const keys = await listSshKeys();

    expect(keys).toHaveLength(1);
    // Пустой отпечаток — «неизвестно», а не повод выкинуть ключ из выбора.
    expect(keys[0]?.fingerprint).toBe('');
    expect(keys[0]?.publicKey).toBe(ED25519);
  });

  it('отпечаток берётся из ответа ssh-keygen', async () => {
    vi.doMock('../src/main/tool', () => ({
      runTool: async () => ({ ok: true, stdout: '256 SHA256:abc123def user@host (ED25519)\n', stderr: '' }),
    }));
    await fakeHome({ 'id.pub': ED25519 });

    const keys = await listSshKeys();

    expect(keys[0]?.fingerprint).toBe('SHA256:abc123def');
  });
});
