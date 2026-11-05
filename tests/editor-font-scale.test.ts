import { describe, expect, it } from 'vitest';
import {
  canStepEditorFontSize,
  EDITOR_FONT_MAX,
  EDITOR_FONT_MIN,
  editorFontSizeLabel,
  sanitizeEditorFontSize,
  stepEditorFontSize,
} from '../src/shared/editor-font-scale';

/**
 * Кегль редактора (TASKS 48).
 *
 * Было: шаг был только у `Ctrl+колеса`, с зашитыми в `app.ts` границами 6..72, а
 * клавиш не было вовсе. Теперь правила живут в одной чистой функции, и клавиши,
 * колесо и поле настроек идут через неё.
 */

describe('шаг кегля', () => {
  it('крупнее и мельче — ровно на пиксель', () => {
    expect(stepEditorFontSize(14, 1)).toBe(15);
    expect(stepEditorFontSize(14, -1)).toBe(13);
  });

  it('у верхней границы не растёт', () => {
    expect(stepEditorFontSize(EDITOR_FONT_MAX, 1)).toBe(EDITOR_FONT_MAX);
  });

  it('у нижней границы не уменьшается', () => {
    expect(stepEditorFontSize(EDITOR_FONT_MIN, -1)).toBe(EDITOR_FONT_MIN);
  });

  it('за границей — «дальше некуда», а не смена ради той же цифры', () => {
    expect(canStepEditorFontSize(EDITOR_FONT_MAX, 1)).toBe(false);
    expect(canStepEditorFontSize(EDITOR_FONT_MIN, -1)).toBe(false);
    expect(canStepEditorFontSize(14, 1)).toBe(true);
  });

  it('мусор считается текущим по умолчанию, а не ломает шаг', () => {
    expect(stepEditorFontSize(Number.NaN, 1)).toBe(15);
    expect(stepEditorFontSize(0, 1)).toBe(15);
  });
});

describe('приведение кегля', () => {
  it('дробное округляется: полупикселя в CSS-кегле не бывает', () => {
    expect(sanitizeEditorFontSize(14.4)).toBe(14);
    expect(sanitizeEditorFontSize(14.6)).toBe(15);
  });

  it('за пределы не пускает', () => {
    expect(sanitizeEditorFontSize(1)).toBe(EDITOR_FONT_MIN);
    expect(sanitizeEditorFontSize(999)).toBe(EDITOR_FONT_MAX);
  });

  it('пустое и мусор — 14: у редактора есть разумный размер по умолчанию', () => {
    expect(sanitizeEditorFontSize(undefined)).toBe(14);
    expect(sanitizeEditorFontSize('abc')).toBe(14);
    expect(sanitizeEditorFontSize(-5)).toBe(14);
  });

  it('строку с числом принимает — из поля настроек может прийти строка', () => {
    expect(sanitizeEditorFontSize('18')).toBe(18);
  });
});

describe('подпись', () => {
  it('тост называет кегль в пикселях', () => {
    expect(editorFontSizeLabel(16)).toBe('Шрифт редактора: 16 px');
  });

  it('подпись показывает допустимую цифру, а не мусор', () => {
    expect(editorFontSizeLabel(999)).toBe('Шрифт редактора: 72 px');
  });
});
