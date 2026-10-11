import { describe, expect, it } from 'vitest';
import { commandFromLens, toCodeLenses } from '../src/shared/lsp-code-lens';

/**
 * Разбор ответа языкового сервера про код-линзы. Правило, а не запуск: у серверов
 * форма одна, и проверяем именно разбор — что вытаскиваем диапазон и команду, а
 * сырой объект сохраняем целиком (его сервер ждёт в `codeLens/resolve`).
 */

const range = { start: { line: 3, character: 0 }, end: { line: 3, character: 8 } };

describe('toCodeLenses', () => {
  it('читает диапазон и готовую команду', () => {
    const result = toCodeLenses([
      { range, command: { title: '3 ссылки', command: 'showReferences', arguments: ['a', 1] } },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]!.range).toEqual(range);
    expect(result[0]!.command).toEqual({ title: '3 ссылки', command: 'showReferences', arguments: ['a', 1] });
  });

  it('линза без команды сохраняется как есть — её разрешит codeLens/resolve', () => {
    const result = toCodeLenses([{ range, data: { id: 7 } }]);

    expect(result).toHaveLength(1);
    expect(result[0]!.command).toBeNull();
    // Сырой объект с `data` нужен целиком: без него второй запрос сервер не поймёт.
    expect(result[0]!.source).toEqual({ range, data: { id: 7 } });
  });

  it('команда без arguments даёт пустой список, а не undefined', () => {
    const result = toCodeLenses([{ range, command: { title: 'Запустить', command: 'run' } }]);

    expect(result[0]!.command).toEqual({ title: 'Запустить', command: 'run', arguments: [] });
  });

  it('записи без диапазона или битые пропускаются', () => {
    const result = toCodeLenses([null, {}, { command: { title: 'x', command: 'y' } }, { range: {} }, { range }]);

    expect(result).toHaveLength(1);
  });

  it('не-массив — пустой список', () => {
    expect(toCodeLenses(null)).toEqual([]);
    expect(toCodeLenses({ range })).toEqual([]);
  });
});

describe('commandFromLens', () => {
  it('читает заголовок и имя команды', () => {
    expect(commandFromLens({ command: { title: 'Открыть', command: 'open' } })).toEqual({
      title: 'Открыть',
      command: 'open',
      arguments: [],
    });
  });

  it('без заголовка или имени команды — null', () => {
    expect(commandFromLens({ command: { command: 'open' } })).toBeNull();
    expect(commandFromLens({ command: { title: 'Открыть' } })).toBeNull();
    expect(commandFromLens({})).toBeNull();
    expect(commandFromLens(null)).toBeNull();
  });
});
