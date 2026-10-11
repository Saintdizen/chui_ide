import { describe, expect, it } from 'vitest';
import {
  checkSandboxImage,
  DEFAULT_SANDBOX,
  DEFAULT_SANDBOX_IMAGE,
  DEFAULT_SANDBOX_WORKDIR,
  formatSandboxLabel,
  normalizeSandboxWorkdir,
  sanitizeSandbox,
  sandboxDockerArgs,
  sandboxNote,
  type AiSandboxSettings,
} from '../src/shared/sandbox';

const base: AiSandboxSettings = {
  enabled: true,
  image: 'python:3.12-slim',
  workdir: '/workspace',
  network: true,
};

describe('checkSandboxImage', () => {
  it('принимает обычные ссылки на образ', () => {
    for (const image of [
      'python:3.12-slim',
      'node:22',
      'ghcr.io/owner/image:1.0',
      'alpine',
      'ubuntu@sha256:0000000000000000000000000000000000000000000000000000000000000000',
    ]) {
      expect(checkSandboxImage(image).ok, image).toBe(true);
    }
  });

  it('отвергает флаг вместо образа — иначе контейнер получит права хоста', () => {
    const result = checkSandboxImage('--privileged');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('дефис');
  });

  it('отвергает пустое имя и пробелы', () => {
    expect(checkSandboxImage('   ').ok).toBe(false);
    expect(checkSandboxImage('python 3.12').ok).toBe(false);
  });

  it('отвергает посторонние символы', () => {
    // Точка с запятой в имени образа — это уже не образ, а попытка что-то подставить.
    expect(checkSandboxImage('python;rm -rf /').ok).toBe(false);
    expect(checkSandboxImage('python:3.12 slim').ok).toBe(false);
  });
});

describe('normalizeSandboxWorkdir', () => {
  it('дефолт для пустого значения', () => {
    expect(normalizeSandboxWorkdir('')).toBe(DEFAULT_SANDBOX_WORKDIR);
    expect(normalizeSandboxWorkdir(undefined)).toBe(DEFAULT_SANDBOX_WORKDIR);
  });

  it('приводит путь к абсолютному виду контейнера', () => {
    expect(normalizeSandboxWorkdir('app')).toBe('/app');
    expect(normalizeSandboxWorkdir('/app/')).toBe('/app');
    expect(normalizeSandboxWorkdir('/a//b')).toBe('/a/b');
  });

  it('отвергает двоеточие: оно ломает запись монтирования хост:контейнер', () => {
    expect(normalizeSandboxWorkdir('/app:/etc')).toBe(DEFAULT_SANDBOX_WORKDIR);
  });

  it('отвергает корень — проект накрыл бы всю файловую систему контейнера', () => {
    expect(normalizeSandboxWorkdir('/')).toBe(DEFAULT_SANDBOX_WORKDIR);
    expect(normalizeSandboxWorkdir('//')).toBe(DEFAULT_SANDBOX_WORKDIR);
  });

  it('отвергает пробелы и выход наверх', () => {
    expect(normalizeSandboxWorkdir('/a b')).toBe(DEFAULT_SANDBOX_WORKDIR);
    expect(normalizeSandboxWorkdir('/../etc')).toBe(DEFAULT_SANDBOX_WORKDIR);
  });
});

describe('sanitizeSandbox', () => {
  it('побитое имя образа возвращается к образцу, а не запускается как есть', () => {
    expect(sanitizeSandbox({ enabled: true, image: '--privileged' })).toEqual({
      enabled: true,
      image: DEFAULT_SANDBOX_IMAGE,
      workdir: DEFAULT_SANDBOX_WORKDIR,
      network: true,
    });
  });

  it('включено только явным true, сеть выключена только явным false', () => {
    expect(sanitizeSandbox({}).enabled).toBe(false);
    expect(sanitizeSandbox({ enabled: 'да' }).enabled).toBe(false);
    expect(sanitizeSandbox({ network: false }).network).toBe(false);
    expect(sanitizeSandbox({ network: 'no' }).network).toBe(true);
  });

  it('пустой вход даёт настройки по умолчанию', () => {
    expect(sanitizeSandbox(null)).toEqual(DEFAULT_SANDBOX);
  });
});

describe('sandboxDockerArgs', () => {
  it('монтирует только корень проекта и никуда больше', () => {
    const args = sandboxDockerArgs(base, 'echo привет', { root: '/home/user/project' });
    const volumes: string[] = [];
    args.forEach((arg, index) => {
      if (arg === '--volume') volumes.push(args[index + 1]!);
    });
    expect(volumes).toEqual(['/home/user/project:/workspace']);
  });

  it('не отдаёт контейнеру домашний каталог, сокет docker и переменные хоста', () => {
    const args = sandboxDockerArgs(base, 'ls', { root: '/home/user/project' });
    // Переменные окружения передаются только свои — хостовые не пробрасываем.
    const envs: string[] = [];
    args.forEach((arg, index) => {
      if (arg === '--env') envs.push(args[index + 1]!);
    });
    expect(envs).toEqual(['NO_COLOR=1', 'TERM=dumb']);
    expect(args.join(' ')).not.toContain('docker.sock');
    expect(args).not.toContain('--privileged');
    // Порт не публикуем и хостовую сеть не подключаем: это отдельный режим, а не «как вышло».
    expect(args).not.toContain('-p');
    expect(args).not.toContain('--network');
  });

  it('выключенная сеть ставит --network none', () => {
    const args = sandboxDockerArgs({ ...base, network: false }, 'ls', { root: '/p' });
    expect(args.join(' ')).toContain('--network none');
  });

  it('контейнер одноразовый: без --rm он копил бы десятки остановленных контейнеров', () => {
    const args = sandboxDockerArgs(base, 'ls', { root: '/p' });
    expect(args.slice(0, 2)).toEqual(['run', '--rm']);
  });

  it('команда уходит после sh -c и не разбирается хостом', () => {
    const command = 'echo "привет" && rm -rf /tmp/x | wc -l';
    const args = sandboxDockerArgs(base, command, { root: '/p' });
    // Команда — ровно один последний аргумент: ни кавычки, ни пайпы не могут
    // «вылезти» из своей позиции и подставить хосту лишний флаг.
    expect(args.at(-3)).toBe('sh');
    expect(args.at(-2)).toBe('-c');
    expect(args.at(-1)).toBe(command);
    expect(args.at(-4)).toBe('python:3.12-slim');
  });

  it('рабочий каталог задаётся и монтируется одним и тем же путём', () => {
    const args = sandboxDockerArgs({ ...base, workdir: '/app' }, 'ls', { root: '/p' });
    expect(args).toContain('--workdir');
    expect(args[args.indexOf('--workdir') + 1]).toBe('/app');
    expect(args).toContain('/p:/app');
  });

  it('владелец файлов передаётся, когда известен', () => {
    const args = sandboxDockerArgs(base, 'ls', { root: '/p', user: '1000:1000' });
    expect(args[args.indexOf('--user') + 1]).toBe('1000:1000');
    expect(sandboxDockerArgs(base, 'ls', { root: '/p' })).not.toContain('--user');
  });

  it('побитый образ и пустой корень — отказ, а не запуск наугад', () => {
    expect(() => sandboxDockerArgs({ ...base, image: '--privileged' }, 'ls', { root: '/p' })).toThrow(/дефис/);
    expect(() => sandboxDockerArgs(base, 'ls', { root: '   ' })).toThrow(/рабочая папка/i);
  });
});

describe('formatSandboxLabel', () => {
  it('называет образ, в котором шла команда', () => {
    expect(formatSandboxLabel(base)).toBe('контейнер python:3.12-slim');
  });

  it('с побитым образом называет образец, а не мусор', () => {
    expect(formatSandboxLabel({ ...base, image: '--privileged' })).toBe(`контейнер ${DEFAULT_SANDBOX_IMAGE}`);
  });
});

describe('sandboxNote', () => {
  it('без движка говорит об отказе и запрещает молчаливый откат на хост', () => {
    const note = sandboxNote(base, false);
    expect(note).toContain('не найден');
    expect(note).toContain('НЕ переключаются');
  });

  it('с движком объясняет, что останется в контейнере, а что общее', () => {
    const note = sandboxNote(base, true);
    expect(note).toContain('python:3.12-slim');
    expect(note).toContain('/workspace');
    expect(note).toContain('Сеть в контейнере разрешена');
  });

  it('выключенная сеть названа прямо', () => {
    expect(sandboxNote({ ...base, network: false }, true)).toContain('Сеть в контейнере выключена');
  });
});
