import { describe, expect, it } from 'vitest';
import { isSafeExternalUrl } from '../src/shared/url';

/**
 * Какие адреса можно отдать системе. Опасны не столько «странные» адреса,
 * сколько знакомые схемы с чужим обработчиком (`file:`), поэтому проверяем
 * и разрешённое, и отказ, и разбор мусора.
 */
describe('isSafeExternalUrl', () => {
  it('http и https — можно', () => {
    expect(isSafeExternalUrl('http://localhost:5273/x')).toBe(true);
    expect(isSafeExternalUrl('https://example.com/docs#anchor')).toBe(true);
  });

  it('mailto — можно', () => {
    expect(isSafeExternalUrl('mailto:dev@example.com')).toBe(true);
  });

  it('регистр схемы не важен', () => {
    expect(isSafeExternalUrl('HTTPS://example.com')).toBe(true);
  });

  it('file и прочие схемы — нельзя', () => {
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('data:text/html,<script></script>')).toBe(false);
  });

  it('не адрес — тоже нельзя', () => {
    expect(isSafeExternalUrl('example.com')).toBe(false);
    expect(isSafeExternalUrl('')).toBe(false);
  });
});
