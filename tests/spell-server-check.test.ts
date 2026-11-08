import { describe, expect, it, vi } from 'vitest';
import { createSpellServerCheck } from '../src/renderer/core/spell-server-check';

/** Диагностика в форме, в какой её отдаёт main. */
const issue = (word: string) => ({
  severity: 'warning' as const,
  line: 0,
  column: 0,
  endLine: 0,
  endColumn: word.length,
  message: `Неизвестное слово: «${word}»`,
  source: 'cspell',
});

function setup(overrides: Partial<Parameters<typeof createSpellServerCheck>[0]> = {}) {
  const setMarkers = vi.fn();
  const request = vi.fn().mockResolvedValue([issue('ашипка')]);
  const check = createSpellServerCheck({
    rpc: { request } as never,
    setMarkers,
    enabled: () => true,
    projectWords: () => ['чую'],
    ...overrides,
  });
  return { check, setMarkers, request };
}

describe('орфография проекта через cSpell', () => {
  it('пометки ложатся отдельным источником cspell', async () => {
    const { check, setMarkers } = setup();
    await check('/p/a.md', 'ашипка');
    expect(setMarkers).toHaveBeenCalledWith('/p/a.md', [issue('ашипка')]);
  });

  it('слова проекта уходят в main: там поверх словарей', async () => {
    const { check, request } = setup();
    await check('/p/a.md', 'текст');
    expect(request).toHaveBeenCalledWith('spell.serverDiagnostics', {
      path: '/p/a.md',
      text: 'текст',
      words: ['чую'],
    });
  });

  it('выключенная проверка снимает прежние пометки', async () => {
    const { check, setMarkers, request } = setup({ enabled: () => false });
    await check('/p/a.md', 'ашипка');
    expect(setMarkers).toHaveBeenCalledWith('/p/a.md', []);
    expect(request).not.toHaveBeenCalled();
  });

  it('сбой main не стирает пометки: пусто значило бы «всё верно»', async () => {
    const { check, setMarkers, request } = setup();
    request.mockRejectedValueOnce(new Error('нет связи'));
    await check('/p/a.md', 'ашипка');
    expect(setMarkers).not.toHaveBeenCalled();
  });

  it('ответ про прошлый файл не ложится на новый', async () => {
    const { check, setMarkers } = setup();
    const slow = check('/p/a.md', 'первый');
    await check('/p/b.md', 'второй');
    setMarkers.mockClear();
    await slow;
    // Медленный ответ про a.md пришёл, когда человек уже смотрит b.md.
    expect(setMarkers).not.toHaveBeenCalled();
  });
});
