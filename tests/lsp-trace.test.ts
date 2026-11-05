import { describe, expect, it } from 'vitest';
import { describeKind, describeMessage, parseTrace } from '../src/shared/lsp-trace';

describe('хвост журнала LSP', () => {
  const line = (direction: string, message: unknown) =>
    JSON.stringify({ at: '2026-11-05T10:00:00.000Z', direction, message });

  it('берёт конец журнала, а не начало', () => {
    const raw = [
      line('client', { method: 'a' }),
      line('server', { method: 'b' }),
      line('client', { method: 'c' }),
    ].join('\n');
    expect(parseTrace(raw, 2).map((item) => item.kind)).toEqual(['b', 'c']);
  });

  it('сервер в строке сохраняется: в журнале живут все сразу', () => {
    const raw = JSON.stringify({
      at: '2026-11-05T10:00:00.000Z',
      direction: 'client',
      server: 'Pyright',
      message: { method: 'x' },
    });
    expect(parseTrace(raw)[0]!.server).toBe('Pyright');
    // Старые строки писались без подписи — пустая строка не должна ронять панель.
    expect(parseTrace(line('client', { method: 'x' }))[0]!.server).toBe('');
  });

  it('недописанная строка не роняет разбор', () => {
    const raw = `${line('client', { method: 'textDocument/hover' })}\n{"at":"2026-11`;
    expect(parseTrace(raw).map((item) => item.kind)).toEqual(['textDocument/hover']);
  });

  it('направление по умолчанию — клиент', () => {
    expect(parseTrace(line('нечто', { method: 'x' }))[0]!.direction).toBe('client');
    expect(parseTrace(line('server', { method: 'x' }))[0]!.direction).toBe('server');
  });

  it('вид сообщения: метод, ответ, ошибка', () => {
    expect(describeKind({ method: 'textDocument/completion' })).toBe('textDocument/completion');
    expect(describeKind({ id: 1, result: null })).toBe('result');
    expect(describeKind({ id: 1, error: { message: 'нет' } })).toBe('error');
    expect(describeKind(null)).toBe('message');
  });

  it('длинное сообщение режется, а не рвёт панель', () => {
    const text = describeMessage({ result: 'x'.repeat(5000) });
    expect(text.length).toBeLessThan(2100);
    expect(text.endsWith('…')).toBe(true);
  });
});
