import { describe, expect, it } from 'vitest';
import {
  addressName,
  addressParent,
  addressProblem,
  addressSchemeOf,
  formatFsAddress,
  fsAddressLabel,
  isFsAddress,
  joinAddress,
  normalizeRemotePath,
  parseFsAddress,
} from '../src/shared/fs-address';
import {
  belongsToAddress,
  clientNameOf,
  listDirCommand,
  mkdirCommand,
  moveCommand,
  parseDirListing,
  parseStat,
  readFileCommand,
  remoteCommand,
  shellQuote,
  sshTargetArgs,
  statCommand,
  writeFileCommand,
} from '../src/main/workspace/remote-fs';

/**
 * Удалённые файловые системы: разбор адресов и формирование команд.
 *
 * Проверяем чистое: адрес (`shared/fs-address.ts`) и команды с разбором вывода
 * (`main/workspace/remote-fs.ts`). Процессов тут нет — живой ssh в тестах не нужен.
 */

describe('разбор адреса', () => {
  it('ssh с пользователем и портом', () => {
    const address = parseFsAddress('ssh://build@ci-server:2222/srv/app');
    expect(address).toEqual({ scheme: 'ssh', authority: 'build@ci-server:2222', path: '/srv/app' });
  });

  it('wsl и контейнер', () => {
    expect(parseFsAddress('wsl://Ubuntu/home/me/app')?.scheme).toBe('wsl');
    expect(parseFsAddress('container://dev-workspace/workspace')?.scheme).toBe('container');
  });

  it('путь по умолчанию — корень, хвостовые слэши снимаются', () => {
    expect(parseFsAddress('ssh://host')?.path).toBe('/');
    expect(parseFsAddress('ssh://host/srv/app/')?.path).toBe('/srv/app');
  });

  it('обратные слэши приводятся к прямым', () => {
    expect(normalizeRemotePath('C:\\work\\app')).toBe('/C:/work/app');
  });

  it('без владельца адрес не разбирается: «куда-то» — это не адрес', () => {
    expect(parseFsAddress('ssh:///srv')).toBeNull();
    expect(parseFsAddress('ssh://')).toBeNull();
  });

  it('обычный путь адресом не считается', () => {
    expect(isFsAddress('/home/me/proj')).toBe(false);
    expect(addressSchemeOf('/home/me/proj')).toBeNull();
    expect(addressSchemeOf('wsl://Ubuntu/home')).toBe('wsl');
  });

  it('сборка и разбор обратимы', () => {
    const text = 'ssh://user@host:22/srv/app';
    expect(formatFsAddress(parseFsAddress(text)!)).toBe(text);
  });
});

describe('части адреса', () => {
  const address = parseFsAddress('ssh://host/srv/app')!;

  it('имя — последний сегмент пути', () => {
    expect(addressName(address)).toBe('app');
    expect(addressName(parseFsAddress('ssh://host')!)).toBe('host');
  });

  it('спуск и подъём', () => {
    expect(joinAddress(address, 'src')).toBe('ssh://host/srv/app/src');
    expect(addressParent(address)).toBe('ssh://host/srv');
    expect(addressParent(parseFsAddress('ssh://host/srv')!)).toBe('ssh://host');
    // Из корня подниматься некуда.
    expect(addressParent(parseFsAddress('ssh://host')!)).toBeNull();
  });

  it('подпись говорит, чем открывается', () => {
    expect(fsAddressLabel(address)).toBe('SSH: host/srv/app');
  });

  it('ошибки разбираются словами — их показывают человеку', () => {
    expect(addressProblem('')).toContain('Пустой');
    expect(addressProblem('/home/me')).toContain('схемой');
    expect(addressProblem('ftp://host/x')).toContain('не поддерживается');
    expect(addressProblem('ssh:///srv')).toContain('владельца');
    expect(addressProblem('ssh://host/srv')).toBeNull();
  });
});

describe('команды клиентам', () => {
  const address = parseFsAddress('ssh://build@ci:2222/srv/app')!;

  it('ssh: пользователь, порт и команда отделены', () => {
    const { file, args } = remoteCommand(address, 'ls');
    expect(file).toBe('ssh');
    expect(args).toEqual(['-p', '2222', 'build@ci', '--', 'ls']);
  });

  it('wsl получает дистрибутив, контейнер — имя', () => {
    expect(remoteCommand(parseFsAddress('wsl://Ubuntu/home')!, 'ls').args).toEqual([
      '-d',
      'Ubuntu',
      '--',
      'sh',
      '-lc',
      'ls',
    ]);
    expect(remoteCommand(parseFsAddress('container://dev/workspace')!, 'ls').args).toEqual([
      'exec',
      'dev',
      'sh',
      '-lc',
      'ls',
    ]);
  });

  it('адресат ssh разбирается и без порта', () => {
    expect(sshTargetArgs('host')).toEqual(['host']);
    expect(sshTargetArgs('user@host')).toEqual(['user@host']);
  });

  it('имена экранируются: кавычка не рвёт команду', () => {
    expect(shellQuote("/srv/it's here")).toBe("'/srv/it'\\''s here'");
    expect(listDirCommand(address)).toContain("'/srv/app'");
  });

  it('чтение ограничено по размеру, запись идёт в cat', () => {
    expect(readFileCommand(address, 1024)).toContain('head -c 1024 --');
    expect(writeFileCommand(address)).toBe("cat > '/srv/app'");
    expect(statCommand(address)).toContain('stat -c');
    expect(mkdirCommand(address)).toContain('mkdir -p');
    expect(moveCommand(address, parseFsAddress('ssh://build@ci:2222/srv/b')!)).toBe("mv -- '/srv/app' '/srv/b'");
  });

  it('«свой адрес» проверяется до открытия файла', () => {
    expect(belongsToAddress(address, 'ssh://build@ci:2222/srv/app/a.ts')).toBe(false);
    const owner = parseFsAddress('ssh://build@ci:2222/srv/app')!;
    expect(belongsToAddress(owner, 'ssh://build@ci:2222/srv/app')).toBe(true);
  });

  it('клиент называется по схеме', () => {
    expect(clientNameOf(address)).toBe('ssh');
    expect(clientNameOf(parseFsAddress('wsl://Ubuntu/home')!)).toBe('wsl');
    expect(clientNameOf(parseFsAddress('container://dev/x')!)).toBe('docker');
  });
});

describe('разбор вывода', () => {
  const address = parseFsAddress('ssh://host/srv/app')!;
  const FIELD = '\u001f';

  it('каталог: вид, время, размер и имя', () => {
    const stdout = [
      `d${FIELD}1700000000${FIELD}4096${FIELD}src`,
      `f${FIELD}1700000001${FIELD}12${FIELD}README.md`,
      `l${FIELD}1700000002${FIELD}0${FIELD}link`,
    ].join('\n');
    const entries = parseDirListing(stdout, address);
    expect(entries.map((entry) => entry.kind)).toEqual(['directory', 'file', 'symlink']);
    expect(entries[0]?.path).toBe('ssh://host/srv/app/src');
    expect(entries[1]?.size).toBe(12);
    expect(entries[0]?.mtimeMs).toBe(1_700_000_000_000);
  });

  it('битые строки пропускаются, а не роняют чтение', () => {
    expect(parseDirListing('\nмусор\n', address)).toEqual([]);
  });

  it('stat: файл, каталог и отсутствие', () => {
    expect(parseStat(`1700000000${FIELD}12${FIELD}regular file`)).toEqual({
      mtimeMs: 1_700_000_000_000,
      size: 12,
      kind: 'file',
    });
    expect(parseStat(`1700000000${FIELD}4096${FIELD}directory`)?.kind).toBe('directory');
    expect(parseStat('')).toBeNull();
  });
});
