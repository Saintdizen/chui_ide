import { describe, expect, it } from 'vitest';
import { decisionCommand } from '../src/shared/agent-grants';

/**
 * Выбор команды из ответа человека: правку выполняем, если она есть.
 * Одно место на все ветки — иначе где-то поправка учитывалась бы, где-то нет.
 */
describe('decisionCommand', () => {
  it('простое «да» — выполняем предложенное', () => {
    expect(decisionCommand(true, 'npm test')).toBe('npm test');
  });

  it('правка человека важнее предложенного', () => {
    expect(decisionCommand({ allowed: true, command: 'pytest -k math' }, 'pytest -t math')).toBe(
      'pytest -k math',
    );
  });

  it('пустая правка — не правка', () => {
    // Иначе стёртое поле превратилось бы в запуск пустой команды.
    expect(decisionCommand({ allowed: true, command: '   ' }, 'npm test')).toBe('npm test');
    expect(decisionCommand({ allowed: true }, 'npm test')).toBe('npm test');
  });

  it('правка обрезается по краям', () => {
    expect(decisionCommand({ allowed: true, command: '  ls -la  ' }, 'ls')).toBe('ls -la');
  });
});
