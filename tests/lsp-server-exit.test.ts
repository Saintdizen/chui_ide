import { describe, expect, it } from 'vitest';
import { exitReason } from '../src/shared/lsp-status';

describe('exitReason: почему сервер исчез', () => {
  it('сигнал назван сигналом', () => {
    expect(exitReason(null, 'SIGSEGV')).toBe('сервер убит сигналом SIGSEGV');
  });

  it('код выхода виден', () => {
    expect(exitReason(1, null)).toBe('сервер завершился (код 1)');
  });

  it('чистый выход тоже объяснён', () => {
    expect(exitReason(0, null)).toBe('сервер завершился');
  });

  it('неизвестно чем — всё равно причина', () => {
    expect(exitReason(null, null)).toBe('сервер завершился');
  });

  it('текст ошибки запуска отличается от сигнала', () => {
    expect(exitReason(null, 'spawn ENOENT')).toBe('сервер не запустился: spawn ENOENT');
  });
});
