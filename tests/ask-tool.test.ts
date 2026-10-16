import { describe, expect, it, vi } from 'vitest';
import { runTool, type ToolContext } from '../src/main/ai/agent-tools';

/** Вопрос человеку — функция хоста: в проверке она мок, а не окно чата. */
type AskFn = (question: string, options?: readonly string[]) => Promise<string>;

function context(ask: AskFn | undefined, extra: Partial<ToolContext> = {}): ToolContext {
  const workspace = { rootPath: () => process.cwd() } as unknown as ToolContext['workspace'];
  return { workspace, ask, ...extra };
}

describe('ask', () => {
  it('отдаёт вопрос человеку и возвращает ответ модели', async () => {
    const ask = vi.fn<AskFn>(async () => 'вариант А');
    const outcome = await runTool(context(ask), 'ask', JSON.stringify({ question: 'Какой подход?' }));

    expect(ask).toHaveBeenCalledWith('Какой подход?', undefined);
    expect(outcome.ok).toBe(true);
    // Ответ идёт модели тем же текстом, что уходит в карточку: без правок и меток.
    expect(outcome.detail).toBe('вариант А');
    expect(outcome.summary).toBe('вариант А');
  });

  it('готовые варианты уходят человеку списком, лишние отсечены', async () => {
    const ask = vi.fn<AskFn>(async () => 'два');
    await runTool(
      context(ask),
      'ask',
      JSON.stringify({ question: 'q', options: ['один', 'два', 'три', 'четыре', 'пять', 'шесть'] }),
    );

    // Больше пяти кнопок — уже список, а не выбор: шестой вариант отсекаем.
    expect(ask.mock.calls[0]![1]).toEqual(['один', 'два', 'три', 'четыре', 'пять']);
  });

  it('одиночная строка в options — это один вариант, а не ошибка', async () => {
    const ask = vi.fn<AskFn>(async () => 'да');
    await runTool(context(ask), 'ask', JSON.stringify({ question: 'q', options: 'да' }));

    expect(ask.mock.calls[0]![1]).toEqual(['да']);
  });

  it('пустой вопрос не доходит до человека', async () => {
    const ask = vi.fn<AskFn>(async () => 'x');
    const outcome = await runTool(context(ask), 'ask', JSON.stringify({ question: '   ' }));

    expect(ask).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
  });

  it('без ответа инструмент отвечает отказом, а не пустой строкой', async () => {
    // Прогон прервали или нажали «Отменить»: карточка отдаёт пустую строку.
    const outcome = await runTool(
      context(async () => ''),
      'ask',
      JSON.stringify({ question: 'q' }),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('Не повторяй');
  });

  it('без моста вопрос недоступен', async () => {
    const outcome = await runTool(context(undefined), 'ask', JSON.stringify({ question: 'q' }));

    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('недоступен');
  });
});
