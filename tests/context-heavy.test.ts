import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ageStaleResults } from '../src/main/ai/age-results';
import type { ChatMessage } from '../src/shared/api';
import { estimateMessagesTokens, trimMessagesToFit } from '../src/shared/context-fit';
import {
  HEAVY_CONTEXT_TOKENS,
  cacheBreakPaybackSteps,
  contextHeavyMessage,
  contextTrimmedMessage,
  midRunTrimDue,
} from '../src/shared/chat-budget';

/**
 * Порог тяжёлого контекста. Окно модели (у deepseek — миллион) говорит, сколько
 * влезет, но не сколько это стоит: контекст едет в каждом шаге прогона. Замер
 * 30 дней показал 195k в среднем, $131 за них, а схемы инструментов — 1.5%
 * счёта. Значит рычаг — объём истории, и порог должен быть ниже окна.
 */

let dir: string | null = null;

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function result(index: number): ChatMessage {
  return {
    role: 'tool',
    toolCallId: `call-${index}`,
    name: 'read_file',
    content: Array.from({ length: 120 }, (_, line) => `${line} | строка ${index}-${line}`).join('\n'),
  };
}

describe('порог тяжёлого контекста', () => {
  it('ниже окна модели и выше состава схем', () => {
    expect(HEAVY_CONTEXT_TOKENS).toBe(80_000);
    expect(HEAVY_CONTEXT_TOKENS).toBeLessThan(200_000);
    expect(HEAVY_CONTEXT_TOKENS).toBeGreaterThan(10_000);
  });

  it('текст называет объём в тысячах токенов', () => {
    const text = contextHeavyMessage(212_000);
    expect(text).toContain('212k');
    expect(text.length).toBeGreaterThan(40);
  });

  it('тяжёлые настройки сворачивают больше обычных', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-'));
    const normal = Array.from({ length: 8 }, (_, i) => result(i));
    const heavy = Array.from({ length: 8 }, (_, i) => result(i));
    // Обычные настройки: все восемь свежие, трогать нечего.
    const quiet = ageStaleResults(normal, { keepRecent: 12, spillDir: dir });
    expect(quiet.aged).toBe(0);
    // Тяжёлый шаг: держим шесть, сворачиваем короткие и по одному.
    const busy = ageStaleResults(heavy, { keepRecent: 6, minChars: 900, batchSize: 1, spillDir: dir });
    expect(busy.aged).toBeGreaterThan(0);
    expect(busy.freedTokens).toBeGreaterThan(0);
    // Свёрнутое не потеряно: в истории остался адрес, а не весь текст.
    expect(String(heavy[0]?.content).length).toBeLessThan(900);
    expect(String(heavy[7]?.content).length).toBeGreaterThan(900);
  });
});

describe('сокращение истории посреди прогона', () => {
  // Запись в кеш 1.25 за токен, попадание 0.1 — отношение 12.5.
  const priced = { input: 1, cachedInput: 0.1, cacheWrite: 1.25 };
  const freeCache = { input: 1, cachedInput: 1, cacheWrite: 1 };

  it('промах кеша окупается только на длинном хвосте шагов', () => {
    expect(cacheBreakPaybackSteps(priced)).toBe(12);
    // Кеша нет — терять нечего, сокращать выгодно сразу.
    expect(cacheBreakPaybackSteps(freeCache)).toBe(1);
    // Цены нет — сравнивать не с чем.
    expect(cacheBreakPaybackSteps(null)).toBe(1);
  });

  it('нужны оба условия: объём и запас шагов', () => {
    const low = HEAVY_CONTEXT_TOKENS - 1;
    const high = HEAVY_CONTEXT_TOKENS + 1;
    expect(midRunTrimDue({ tokens: low, stepsLeft: 40, pricing: priced })).toBe(false);
    // Последние шаги: сокращение — чистый убыток, даже если контекст огромен.
    expect(midRunTrimDue({ tokens: high, stepsLeft: 5, pricing: priced })).toBe(false);
    expect(midRunTrimDue({ tokens: high, stepsLeft: 20, pricing: priced })).toBe(true);
  });

  it('сокращение снимает объём и оставляет свежий ход', () => {
    const filler = 'я'.repeat(3_000);
    const history: ChatMessage[] = [];
    for (let i = 0; i < 60; i += 1) {
      history.push({ role: 'user', content: `шаг ${i}` });
      history.push({ role: 'assistant', content: filler });
    }
    const before = estimateMessagesTokens(history);
    expect(before).toBeGreaterThan(HEAVY_CONTEXT_TOKENS);
    const trimmed = trimMessagesToFit(history, {
      limitTokens: HEAVY_CONTEXT_TOKENS,
      overheadTokens: 0,
      reserveTokens: 0,
      keepRecent: 4,
      marker: 'опущено',
    });
    expect(trimmed.dropped).toBeGreaterThan(0);
    // Режет ровно до порога, не глубже: лишнего не выбрасываем.
    expect(estimateMessagesTokens(trimmed.messages)).toBeLessThanOrEqual(HEAVY_CONTEXT_TOKENS);
    // Свежий ход цел: по нему модель понимает, что уже сделано.
    expect(trimmed.messages.at(-1)?.content).toBe(filler);
  });

  it('человеку говорят и объём, и сколько опущено', () => {
    const text = contextTrimmedMessage(96_000, 14);
    expect(text).toContain('96k');
    expect(text).toContain('14');
  });
});
