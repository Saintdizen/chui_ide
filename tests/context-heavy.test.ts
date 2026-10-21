import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ageStaleResults } from '../src/main/ai/age-results';
import type { ChatMessage } from '../src/shared/api';
import { HEAVY_CONTEXT_TOKENS, contextHeavyMessage } from '../src/shared/chat-budget';

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
