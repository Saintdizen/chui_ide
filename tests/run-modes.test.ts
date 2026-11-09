import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RUN_MODES,
  actionClassOf,
  runModeAllows,
  runModeDenied,
  runModesTouched,
  sanitizeRunModes,
  type RunModes,
} from '../src/shared/permissions';

describe('режимы исполнения: как читается настройка', () => {
  it('по умолчанию политика молчит: всё решает пресет', () => {
    expect(runModesTouched(DEFAULT_RUN_MODES)).toBe(false);
    expect(runModeAllows(DEFAULT_RUN_MODES, 'write')).toBeUndefined();
  });

  it('allow разрешает мимо пресета, deny запрещает', () => {
    const modes: RunModes = { ...DEFAULT_RUN_MODES, command: 'deny', network: 'allow' };
    expect(runModeAllows(modes, 'network')).toBe(true);
    expect(runModeAllows(modes, 'command')).toBe(false);
    expect(runModeDenied(modes, 'command')).toBe(true);
    expect(runModeDenied(modes, 'write')).toBe(false);
    expect(runModesTouched(modes)).toBe(true);
  });

  it('`ask` не даёт своего ответа — спрашивает пресет', () => {
    const modes: RunModes = { ...DEFAULT_RUN_MODES, write: 'ask' };
    expect(runModeAllows(modes, 'write')).toBeUndefined();
    expect(runModeDenied(modes, 'write')).toBe(false);
  });

  it('опечатка в правиле — не разрешение', () => {
    // Ошибка в эту сторону стоит лишнего вопроса, в обратную — молчаливо
    // выполненной команды. Режим — не место для догадок.
    expect(runModeDenied(sanitizeRunModes({ command: 'alow' }), 'command')).toBe(false);
    expect(runModeDenied(sanitizeRunModes({ command: 'deny' }), 'command')).toBe(true);
  });

  it('неизвестный инструмент считается чтением', () => {
    expect(actionClassOf('что-то-новое')).toBe('read');
    expect(actionClassOf('edit')).toBe('write');
    expect(actionClassOf('run')).toBe('command');
    expect(actionClassOf('web')).toBe('network');
  });
});
