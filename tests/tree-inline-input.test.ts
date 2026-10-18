import { describe, expect, it } from 'vitest';
import { readStyle } from './style-files';

/**
 * Поле имени в дереве проекта (создание файла, папки, переименование).
 *
 * Оно появляется прямо в строке дерева, и у него уже есть рамка в цвете фокуса.
 * Пока под ним была ещё и подложка (`--sunken_background` у поля и
 * `--element_background_hover` у самой строки), на экране получались две вложенные
 * плашки с рамкой внутри — поле читалось как отдельное окно поверх дерева, хотя
 * это та же строка. Ориентир должен быть один: синяя обводка.
 *
 * Сторож держит ровно это: у поля и у его строки фона нет, а индикатор фокуса
 * остаётся один (иначе `:focus-visible` добавлял бы вторую рамку).
 */

const CHROME = readStyle('chrome.css');

/** Тело правила по селектору: первое совпадение в таблице. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return CHROME.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('поле имени в дереве — только обводка, без подложки', () => {
  it('у поля нет своего фона', () => {
    const body = rule('.tree-input');
    expect(body).not.toBe('');
    expect(body).toContain('background: transparent');
    expect(body).not.toContain('--sunken_background');
  });

  it('у строки с полем нет подложки: фона под полем быть не должно', () => {
    const body = rule('.tree-row.is-editing');
    expect(body).not.toBe('');
    expect(body).toContain('background: transparent');
    expect(body).not.toContain('--element_background_hover');
  });

  it('обводка фокуса у поля одна — своя рамка в цвете фокуса', () => {
    expect(rule('.tree-input')).toContain('border: 1px solid var(--focus_ring_color)');
    // Вторая рамка от глобального `:focus-visible` дала бы двойной контур.
    expect(rule('.tree-input:focus')).toContain('outline: none');
  });
});
