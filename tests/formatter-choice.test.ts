import { describe, expect, it } from 'vitest';
import { FORMATTER_CHOICES, FORMATTER_LABELS, normalizeFormatterChoice, planFormatting } from '../src/shared/formatter';

/**
 * Выбор форматтера (TASKS 46).
 *
 * Было: порядок зашит в `formatDocument` — сервер пробовали всегда, инструмент —
 * только если сервер молчал. Причин для выбора не было никаких: при обоих готовых
 * источниках файл форматировал тот, кто первым ответил.
 */

describe('настройка', () => {
  it('незнакомое значение читается как auto', () => {
    expect(normalizeFormatterChoice('prettier')).toBe('auto');
    expect(normalizeFormatterChoice(undefined)).toBe('auto');
    expect(normalizeFormatterChoice('lsp')).toBe('lsp');
    expect(normalizeFormatterChoice('tool')).toBe('tool');
  });

  it('у каждого выбора есть подпись', () => {
    for (const choice of FORMATTER_CHOICES) expect(FORMATTER_LABELS[choice]).toBeTruthy();
  });
});

describe('порядок источников', () => {
  it('auto: сервер первым, инструмент — запасным', () => {
    expect(planFormatting({ choice: 'auto', lspAvailable: true, toolAvailable: true })).toEqual({
      first: 'lsp',
      fallback: 'tool',
      complaint: null,
    });
  });

  it('auto: один готовый источник — без запаса', () => {
    expect(planFormatting({ choice: 'auto', lspAvailable: false, toolAvailable: true })).toEqual({
      first: 'tool',
      fallback: null,
      complaint: null,
    });
    expect(planFormatting({ choice: 'auto', lspAvailable: true, toolAvailable: false })).toEqual({
      first: 'lsp',
      fallback: null,
      complaint: null,
    });
  });

  it('auto: нечего — молча, как раньше', () => {
    expect(planFormatting({ choice: 'auto', lspAvailable: false, toolAvailable: false })).toEqual({
      first: null,
      fallback: null,
      complaint: null,
    });
  });

  it('выбор явный и источник есть — без подмены', () => {
    expect(planFormatting({ choice: 'tool', lspAvailable: true, toolAvailable: true })).toEqual({
      first: 'tool',
      fallback: null,
      complaint: null,
    });
    expect(planFormatting({ choice: 'lsp', lspAvailable: true, toolAvailable: true })).toEqual({
      first: 'lsp',
      fallback: null,
      complaint: null,
    });
  });

  it('выбранный источник недоступен — молча другого не берём, а говорим почему', () => {
    const tool = planFormatting({ choice: 'tool', lspAvailable: true, toolAvailable: false });
    expect(tool.first).toBeNull();
    expect(tool.complaint).toContain('Инструмент проекта не найден');

    const lsp = planFormatting({ choice: 'lsp', lspAvailable: false, toolAvailable: true });
    expect(lsp.first).toBeNull();
    expect(lsp.complaint).toContain('не умеет форматировать');
  });
});
