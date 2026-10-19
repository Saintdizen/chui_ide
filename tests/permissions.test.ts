import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERMISSION,
  PERMISSION_PRESETS,
  permissionFlags,
  permissionFromAutoApprove,
  permissionSpec,
  sanitizePermission,
} from '../src/shared/permissions';

/**
 * Права ассистента: один выбор на два независимых рычага.
 *
 * Главное, что здесь проверяется, — соответствие подписей и флагов. Ошибка в этой
 * таблице стоит дорого: «Правки» не должны молча разрешать команды, а непонятное
 * значение не должно случайно включать полный доступ.
 */

describe('таблица пресетов', () => {
  it('сочетания идут по возрастанию свободы, безопасное — первым', () => {
    expect(PERMISSION_PRESETS.map((item) => item.id)).toEqual(['ask', 'edits', 'full']);
    expect(DEFAULT_PERMISSION).toBe('ask');
  });

  it('флаги соответствуют смыслу подписи', () => {
    expect(permissionFlags('ask')).toEqual({ autoApprove: false, allowAll: false });
    // Середина: правки сразу, команды — с вопросом. Именно её не хватало тумблеру.
    expect(permissionFlags('edits')).toEqual({ autoApprove: true, allowAll: false });
    expect(permissionFlags('full')).toEqual({ autoApprove: true, allowAll: true });
  });

  it('у каждого пресета есть подпись, значок и пояснение', () => {
    for (const item of PERMISSION_PRESETS) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.icon.length).toBeGreaterThan(0);
      expect(item.hint.length).toBeGreaterThan(0);
    }
  });

  it('неизвестное значение считается «спрашивать», а не свободой', () => {
    // Ошибка в эту сторону стоит одного лишнего вопроса; в обратную — файла,
    // изменённого без спроса.
    expect(sanitizePermission('всё можно')).toBe('ask');
    expect(sanitizePermission(null)).toBe('ask');
    expect(sanitizePermission(undefined)).toBe('ask');
    expect(sanitizePermission(42)).toBe('ask');
    expect(sanitizePermission('full')).toBe('full');
  });

  it('старый флаг autoApprove переводится в полный доступ', () => {
    expect(permissionFromAutoApprove(true)).toBe('full');
    expect(permissionFromAutoApprove(false)).toBe('ask');
    expect(permissionFromAutoApprove(undefined)).toBe('ask');
  });

  it('spec ищется по идентификатору и не падает на выдумке', () => {
    expect(permissionSpec('edits').label).toBe('Правки');
    expect(permissionSpec('нет-такого' as never).id).toBe('ask');
  });
});
