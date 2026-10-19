import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CREDENTIALS_FILE,
  CredentialsStore,
  credentialsPathFor,
  parseCredentials,
  takeKeys,
} from '../src/main/credentials';

/**
 * Секреты отдельно от настроек.
 *
 * Проверяем три вещи: файл ключей разбирается терпимо (правка руками не должна
 * ломать IDE), права у него «только владельцу», и старые ключи из `settings.json`
 * переносятся — иначе обновление потеряло бы ключ у всех, у кого он был.
 */
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'chui-credentials-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parseCredentials', () => {
  it('читает ключи провайдеров и поиска', () => {
    expect(parseCredentials({ providers: { openai: 'sk-1', anthropic: 'sk-2' }, webSearch: 'brave' })).toEqual({
      providers: { openai: 'sk-1', anthropic: 'sk-2' },
      webSearch: 'brave',
    });
  });

  it('мусор даёт пустой набор, а не падение', () => {
    expect(parseCredentials(null)).toEqual({ providers: {} });
    expect(parseCredentials('строка')).toEqual({ providers: {} });
    expect(parseCredentials({ providers: 'нет' })).toEqual({ providers: {} });
    expect(parseCredentials({ providers: { a: 5, b: '', c: null } })).toEqual({ providers: {} });
  });

  it('пробелы по краям снимаются', () => {
    expect(parseCredentials({ providers: { openai: '  sk-1  ' } })).toEqual({ providers: { openai: 'sk-1' } });
  });
});

describe('takeKeys', () => {
  it('забирает ключи из старого файла настроек', () => {
    const { secrets, found } = takeKeys({
      providers: [{ id: 'openai', apiKey: 'sk-1' }, { id: 'custom' }],
      webSearch: 'brave',
    });
    expect(found).toBe(true);
    expect(secrets).toEqual({ providers: { openai: 'sk-1' }, webSearch: 'brave' });
  });

  it('когда переносить нечего — ничего и не находит', () => {
    expect(takeKeys({ providers: [{ id: 'openai' }, {}] })).toEqual({ secrets: { providers: {} }, found: false });
    expect(takeKeys({ providers: [], webSearch: '   ' }).found).toBe(false);
  });

  it('провайдер без имени пропускается', () => {
    expect(takeKeys({ providers: [{ apiKey: 'sk-1' }] }).found).toBe(false);
  });
});

describe('CredentialsStore', () => {
  it('сохраняет и читает ключ, не трогая настройки', () => {
    const dir = tempDir();
    const store = new CredentialsStore(path.join(dir, CREDENTIALS_FILE));
    store.set('openai', 'sk-1');

    expect(store.get('openai')).toBe('sk-1');
    expect(store.get('anthropic')).toBeUndefined();
    // Файл лежит отдельно: в настройках ключей нет вовсе.
    const raw = JSON.parse(readFileSync(path.join(dir, CREDENTIALS_FILE), 'utf8')) as {
      providers: Record<string, string>;
    };
    expect(raw.providers.openai).toBe('sk-1');
  });

  it('пустая строка стирает ключ, как «Убрать ключ»', () => {
    const dir = tempDir();
    const store = new CredentialsStore(path.join(dir, CREDENTIALS_FILE));
    store.set('openai', 'sk-1');
    store.set('openai', '   ');
    expect(store.get('openai')).toBeUndefined();
  });

  it('права файла — только владельцу', () => {
    const dir = tempDir();
    const file = path.join(dir, CREDENTIALS_FILE);
    const store = new CredentialsStore(file);
    store.set('openai', 'sk-1');

    // Windows прав POSIX не знает — там проверка бессмысленна.
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('существующий файл с широкими правами сужается при записи', () => {
    const dir = tempDir();
    const file = path.join(dir, CREDENTIALS_FILE);
    writeFileSync(file, '{"providers":{}}', { encoding: 'utf8', mode: 0o644 });
    const store = new CredentialsStore(file);
    store.set('openai', 'sk-1');

    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('побитый файл читается как пустой: ключ спросят заново, а не упадёт IDE', () => {
    const dir = tempDir();
    const file = path.join(dir, CREDENTIALS_FILE);
    writeFileSync(file, 'не json', 'utf8');
    expect(new CredentialsStore(file).isEmpty()).toBe(true);
  });

  it('adopt не перетирает уже введённый ключ', () => {
    const dir = tempDir();
    const store = new CredentialsStore(path.join(dir, CREDENTIALS_FILE));
    store.set('openai', 'новый');
    const changed = store.adopt({ providers: { openai: 'старый', anthropic: 'sk-2' } });

    expect(changed).toBe(true);
    expect(store.get('openai')).toBe('новый');
    expect(store.get('anthropic')).toBe('sk-2');
  });

  it('adopt без нового ничего не пишет', () => {
    const dir = tempDir();
    const store = new CredentialsStore(path.join(dir, CREDENTIALS_FILE));
    expect(store.adopt({ providers: {} })).toBe(false);
  });

  it('ключ поиска живёт в том же файле, но отдельным полем', () => {
    const dir = tempDir();
    const store = new CredentialsStore(path.join(dir, CREDENTIALS_FILE));
    store.setWebSearch('brave-key');
    expect(store.getWebSearch()).toBe('brave-key');
    expect(store.isEmpty()).toBe(false);
    store.setWebSearch('');
    expect(store.getWebSearch()).toBeUndefined();
  });

  it('файл ключей лежит рядом с настройками', () => {
    expect(credentialsPathFor(path.join(path.sep, 'data', 'settings.json'))).toBe(
      path.join(path.sep, 'data', CREDENTIALS_FILE),
    );
  });
});
