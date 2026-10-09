import { describe, expect, it } from 'vitest';
import { failureMessage } from '../src/main/python/environments';

/**
 * Сообщение о сбое команды окружения. Смысл подсказок — назвать причину там, где
 * она неочевидна: на Debian/Ubuntu venv и pip вынесены в отдельный пакет, и без
 * подсказки человек видит лишь «No module named pip» и не знает, что делать.
 */
describe('failureMessage', () => {
  it('называет команду, аргументы, код выхода и последнюю строку', () => {
    const message = failureMessage('python3', ['-m', 'venv', '.venv'], 1, ['шум', 'boom']);
    expect(message).toContain('python3 -m venv .venv');
    expect(message).toContain('код выхода 1');
    expect(message).toContain('boom');
  });

  it('подсказывает про пакет python3.X-venv, если нет ensurepip', () => {
    const message = failureMessage('python3', ['-m', 'venv', '.venv'], 1, ['Error: ensurepip is not available']);
    expect(message).toContain('нет модуля venv');
    expect(message).toContain('python3.X-venv');
  });

  it('подсказывает про pip, если окружение создано без него', () => {
    const message = failureMessage('python', ['-m', 'pip', 'install', 'six'], 1, ['python: No module named pip']);
    expect(message).toContain('нет pip');
    expect(message).toContain('python3.X-venv');
  });

  it('на прочих сбоях добавляет только последнюю строку', () => {
    const message = failureMessage('pip', ['install', 'x'], 2, ['collecting', 'ERROR: no such package']);
    expect(message).toContain('ERROR: no such package');
    expect(message).not.toContain('python3.X-venv');
  });

  it('не падает без вывода вовсе', () => {
    expect(failureMessage('x', [], null, [])).toContain('код выхода null');
  });
});
