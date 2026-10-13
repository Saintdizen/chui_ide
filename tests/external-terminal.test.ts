import { describe, expect, it } from 'vitest';
import { knownLinuxTerminals, pickExternalTerminal } from '../src/shared/external-terminal';

/** Доступность команд задаётся списком: так проверка не зависит от машины. */
const only =
  (...commands: string[]) =>
  (command: string) =>
    commands.includes(command);

/**
 * Выбор терминала системы: свой из настройки → известные по порядку частоты.
 * Доводы «откройся в этой папке» у терминалов разные, поэтому проверяем и их.
 */
describe('pickExternalTerminal: свой выбор', () => {
  it('выбор человека идёт первым', () => {
    expect(pickExternalTerminal('linux', '/p', only('xterm', 'kitty'), { preferred: 'kitty' })).toEqual({
      command: 'kitty',
      args: [],
    });
  });

  it('недоступный выбор игнорируется — берётся известный', () => {
    const launch = pickExternalTerminal('linux', '/p', only('xterm'), { preferred: 'нет-такого' });
    expect(launch).toEqual({ command: 'xterm', args: [] });
  });
});

describe('pickExternalTerminal: linux', () => {
  it('берёт первый доступный по порядку частоты', () => {
    expect(pickExternalTerminal('linux', '/p', only('gnome-terminal', 'konsole'))).toEqual({
      command: 'gnome-terminal',
      args: ['--working-directory=/p'],
    });
  });

  it('у konsole свой довод каталога', () => {
    expect(pickExternalTerminal('linux', '/p', only('konsole'))).toEqual({
      command: 'konsole',
      args: ['--workdir', '/p'],
    });
  });

  it('у xterm каталог передаётся рабочим каталогом процесса', () => {
    expect(pickExternalTerminal('linux', '/p', only('xterm'))).toEqual({ command: 'xterm', args: [] });
  });

  it('ничего не найдено — ответ null, а не выдуманная команда', () => {
    expect(pickExternalTerminal('linux', '/p', () => false)).toBeNull();
  });
});

describe('pickExternalTerminal: darwin', () => {
  it('открывает Terminal через open в нужной папке', () => {
    expect(pickExternalTerminal('darwin', '/Users/me/p', only('open'))).toEqual({
      command: 'open',
      args: ['-a', 'Terminal', '/Users/me/p'],
    });
  });

  it('без open — null', () => {
    expect(pickExternalTerminal('darwin', '/p', () => false)).toBeNull();
  });
});

describe('pickExternalTerminal: win32', () => {
  it('запускает новое окно cmd', () => {
    const launch = pickExternalTerminal('win32', 'C:\\p', (command) => command.endsWith('cmd.exe'), {
      comspec: 'C:\\Windows\\System32\\cmd.exe',
    });
    expect(launch?.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(launch?.args).toEqual(['/c', 'start', '', 'cmd']);
  });
});

describe('knownLinuxTerminals', () => {
  it('перечисляет известные терминалы', () => {
    expect(knownLinuxTerminals()).toContain('gnome-terminal');
    expect(knownLinuxTerminals()).toContain('xterm');
  });
});
