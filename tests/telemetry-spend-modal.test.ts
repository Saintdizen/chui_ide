import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installMiniDom } from './helpers/mini-dom';
import type { AiTelemetrySnapshot } from '../src/shared/api';
import { summarizeSpend } from '../src/shared/spend';

/**
 * Расход за сегодня в журнале прогонов.
 *
 * Сводка считается в main по всему журналу, а модалка только показывает её —
 * поэтому проверяем обе половины стыка: что окно печатает сумму и разбивку по
 * моделям и что «нет цены» названо вслух, а не показано нулём.
 */

function record(at: number, model: string, prompt: number, completion: number) {
  return {
    at,
    provider: 'openai',
    model,
    conversationUid: 'c1',
    mode: 'agent' as const,
    status: 'done' as const,
    steps: 1,
    toolCalls: 1,
    durationMs: 10,
    trace: { steps: [], toolCalls: [], usage: { promptTokens: prompt, completionTokens: completion } },
  } as unknown as Parameters<typeof summarizeSpend>[0][number];
}

const NOW = new Date(2026, 10, 7, 15, 0, 0).getTime();

function snapshot(today: AiTelemetrySnapshot['today']): AiTelemetrySnapshot {
  return { enabled: true, path: '/tmp/runs.jsonl', bytes: 100, records: [], today };
}

describe('сегодняшний расход в журнале', () => {
  let rpc: { request: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    installMiniDom();
    vi.resetModules();
    rpc = { request: vi.fn(async () => null) };
  });

  async function openModal(loaded: AiTelemetrySnapshot) {
    rpc.request.mockResolvedValue(loaded);
    const { createTelemetryModal } = await import('../src/renderer/ui/telemetry-modal');
    const modal = createTelemetryModal({
      rpc: rpc as never,
      onError: () => undefined,
    });
    // `open` сам ждёт ответа main и только потом рисует.
    await modal.open();
    return modal.element.textContent ?? '';
  }

  it('печатает сумму и разбивку по моделям', async () => {
    const today = summarizeSpend(
      [record(NOW - 1000, 'gpt-4o', 1_000_000, 0), record(NOW - 2000, 'gpt-4o-mini', 1_000_000, 0)],
      NOW,
    );
    const text = await openModal(snapshot(today));
    expect(text).toContain('за 2 прогон');
    // Обе модели названы: без разбивки сумма не отвечает на вопрос «на что ушло».
    expect(text).toContain('gpt-4o');
    expect(text).toContain('gpt-4o-mini');
  });

  it('неизвестная цена названа словами, а не нулём', async () => {
    const today = summarizeSpend([record(NOW - 1000, 'local-unknown', 10, 10)], NOW);
    const text = await openModal(snapshot(today));
    expect(text).toContain('без цены');
    expect(text).not.toContain('$0,00');
  });

  it('пустой день не рисует строку расхода', async () => {
    const today = summarizeSpend([], NOW);
    const text = await openModal(snapshot(today));
    expect(text).not.toContain('прогон(ов) без цены');
  });
});
