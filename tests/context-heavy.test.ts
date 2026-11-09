import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ageStaleResults } from '../src/main/ai/age-results';
import type { ChatMessage } from '../src/shared/api';
import { estimateMessagesTokens, trimMessagesToFit } from '../src/shared/context-fit';
import {
  HEAVY_CONTEXT_TOKENS,
  PRICE_PLAN_STEPS,
  cacheBreakPaybackSteps,
  contextHeavyMessage,
  contextPriceNote,
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
  it('выбран по замеру, а не по окну модели', () => {
    // Замер 09.11 по 722 прогонам: старый порог 80 000 не достигался ни разу
    // (пик 68 702, медиана пика 12 949) — предупреждение и сокращение истории
    // молчали весь срок жизни журнала. 20 000 выбирает 95 прогонов (13%).
    expect(HEAVY_CONTEXT_TOKENS).toBe(20_000);
    // Выше состава схем (1594 тк) — иначе срабатывало бы на каждом прогоне.
    expect(HEAVY_CONTEXT_TOKENS).toBeGreaterThan(10_000);
    expect(HEAVY_CONTEXT_TOKENS).toBeLessThan(200_000);
  });

  it('текст называет объём в тысячах токенов', () => {
    const text = contextHeavyMessage(212_000);
    expect(text).toContain('212k');
    expect(text.length).toBeGreaterThan(40);
  });

  it('цена контекста названа числом и окупаемостью', () => {
    const text = contextPriceNote(12_400, 30);
    expect(text).toContain('12.4k');
    // Хвост прогона: та же история поедет ещё тридцать раз.
    expect(text).toContain('30');
    expect(text).toContain('372k');
    // Пустой контекст — молчим, а не пишем «0k».
    expect(contextPriceNote(0, 5)).toBe('');
    // Без счёта шагов — только текущий вес.
    expect(contextPriceNote(5000)).toContain('5k');
  });

  it('хвост считается по остатку шагов, а не по потолку', () => {
    // `steps` — остаток прогона. Строка про «ещё 245645k» рождалась, когда
    // в функцию клали потолок шагов (500) вместо runPlan - runSteps.
    const text = contextPriceNote(400_100, 3);
    expect(text).toContain('400.1k');
    expect(text).toContain('3 шагов');
    expect(text).toContain('1200k');
    // Потолок шагов в остаток не попадает по построению — сам зовущий его
    // вычитает; функция обязана честно считать то, что дали.
    expect(contextPriceNote(14_400, PRICE_PLAN_STEPS)).toContain('14.4k');
  });

  it('хвост длинного прогона не пропадает и не перепланируется', () => {
    // Замер п.11: на прогоне в 60 шагов `min(steps, 50)` обнулял остаток
    // с 50-го шага — подпись молчала при живых шагах. Теперь остаток берётся
    // по потолку прогона, а `planSteps` только ограничивает ОБЕЩАННУЮ сумму.
    const tail = contextPriceNote(200_000, 10, 5);
    expect(tail).toContain('200k');
    expect(tail).toContain('5 шагов');
    expect(tail).toContain('1000k');
    // Остаток меньше бюджета — считаем по факту, а не по бюджету.
    expect(contextPriceNote(200_000, 3, 50)).toContain('3 шагов');
  });

  it('подпись не обещает больше потолка плана', () => {
    // Было «ещё как минимум N k» — слово «минимум» переворачивало смысл:
    // planSteps — это верхняя граница обещания, а не нижняя.
    const planned = contextPriceNote(200_000, 300, PRICE_PLAN_STEPS);
    expect(planned).not.toContain('как минимум');
    expect(planned).toContain('В пределах');
    expect(planned).toContain(`${PRICE_PLAN_STEPS} шагов`);
    expect(planned).toContain(`${(200 * PRICE_PLAN_STEPS)}k`);
    // Факт короче плана — считаем по факту.
    const short = contextPriceNote(200_000, 3, PRICE_PLAN_STEPS);
    expect(short).not.toContain('как минимум');
    expect(short).toContain('3 шагов');
    // Остаток неизвестен — только вес шага, без «до конца прогона».
    const noTail = contextPriceNote(200_000, 0, PRICE_PLAN_STEPS);
    expect(noTail).toBe('Цена контекста: 200k токенов едет в каждом шаге.');
  });

  it('подпись о цене не обгоняет сокращение истории', () => {
    // Замер 09.11 по `carried` в runs*.jsonl: на шаге 0 подпись объявляла
    // 258.8k «в каждом шаге», а после свёртки ехало 20.3k — обещание было
    // правдой ровно один шаг, хвост завышался в 12 раз. Дефект был в ПОРЯДКЕ
    // в service.ts: подпись и `carried` считались до trimMessagesToFit и
    // ageStaleResults. Тест сторожит порядок, а не формулу: он показывает,
    // что два веса дают РАЗНУЮ подпись, и путать их нельзя.
    // Пары ход-результат: `tool` без своего вызова границей не считается —
    // не порвать протокол можно только на `user`, поэтому тяжёлый груз
    // кладём в сами вопросы, как в жизни (файл в вопросе человека).
    const raw = Array.from({ length: 30 }, (_, i) => ({
      role: 'user' as const,
      content: `вопрос ${i} ` + 'строка ввода '.repeat(400),
    }));
    const rawWeight = estimateMessagesTokens(raw);
    const { messages: kept, dropped } = trimMessagesToFit(raw, {
      limitTokens: HEAVY_CONTEXT_TOKENS,
    });
    const sentWeight = estimateMessagesTokens(kept);

    expect(rawWeight).toBeGreaterThan(HEAVY_CONTEXT_TOKENS);
    expect(dropped).toBeGreaterThan(0);
    expect(sentWeight).toBeLessThan(rawWeight / 2);
    // Та же формула на сырье и на отправляемом — разные обещания.
    expect(contextPriceNote(rawWeight, 10, PRICE_PLAN_STEPS)).not.toBe(
      contextPriceNote(sentWeight, 10, PRICE_PLAN_STEPS),
    );
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
