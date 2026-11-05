import { describe, expect, it } from 'vitest';
import { parseShowMessage } from '../src/shared/lsp-notifications';

const server = { language: 'python', command: 'pyright-langserver', label: 'Pyright' };

describe('window/showMessage — в уведомление', () => {
  it('тип, текст и кто сказал', () => {
    expect(parseShowMessage({ type: 1, message: 'нет окружения Python' }, server)).toEqual({
      severity: 'error',
      message: 'нет окружения Python',
      server: 'Pyright',
    });
  });

  it('четыре типа LSP становятся четырьмя видами', () => {
    const kinds = [1, 2, 3, 4].map((type) => parseShowMessage({ type, message: 'x' }, server)?.severity);
    expect(kinds).toEqual(['error', 'warning', 'info', 'log']);
  });

  it('без подписи сервер называется командой, а не пустотой', () => {
    const unnamed = parseShowMessage({ type: 3, message: 'ок' }, { language: 'go', command: 'gopls' });
    expect(unnamed?.server).toBe('gopls');
  });

  it('пустое сообщение — не уведомление', () => {
    expect(parseShowMessage({ type: 1, message: '   ' }, server)).toBeNull();
    expect(parseShowMessage(null, server)).toBeNull();
    expect(parseShowMessage('строка', server)).toBeNull();
  });

  it('неизвестный тип — info, а не потеря', () => {
    expect(parseShowMessage({ type: 99, message: 'что-то' }, server)?.severity).toBe('info');
  });
});
