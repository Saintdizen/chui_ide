import { describe, expect, it } from 'vitest';
import {
  exposedToolName,
  isMcpToolName,
  MAX_MCP_TOOLS,
  mcpToolResultText,
  normalizeMcpServers,
  parseMcpTools,
  selectMcpTools,
  type McpToolInfo,
} from '../src/shared/mcp';

/**
 * Внешние инструменты: сервер — чужая программа, поэтому проверяем не только
 * разбор нормального ответа, но и поведение на мусоре. Ошибка здесь стоит дорого:
 * кривое имя отвергает весь запрос к модели, а не один вызов.
 */
describe('exposedToolName', () => {
  it('имя собирается из сервера и инструмента', () => {
    expect(exposedToolName('files', 'read')).toBe('mcp__files__read');
  });

  it('чужие символы заменяются, двойное подчёркивание схлопывается', () => {
    expect(exposedToolName('my server', 'read.file')).toBe('mcp__my_server__read_file');
    expect(exposedToolName('a__b', 'x')).toBe('mcp__a_b__x');
  });

  it('разделитель в имени ровно один: имя разбирается обратно', () => {
    const name = exposedToolName('github', 'list__issues');
    expect(name.split('__')).toHaveLength(3);
  });

  it('пустое имя не даёт пустого инструмента', () => {
    expect(exposedToolName('', '')).toBe('mcp__server__tool');
    expect(exposedToolName('///', '***')).toBe('mcp__server__tool');
  });

  it('длинное имя обрезается до лимита API', () => {
    const long = exposedToolName('server', 'x'.repeat(200));
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.startsWith('mcp__server__')).toBe(true);
  });
});

describe('isMcpToolName', () => {
  it('внешние имена узнаются по префиксу', () => {
    expect(isMcpToolName('mcp__files__read')).toBe(true);
    expect(isMcpToolName('read_file')).toBe(false);
  });
});

describe('parseMcpTools', () => {
  it('берёт имя, описание и схему', () => {
    const tools = parseMcpTools('files', {
      tools: [
        {
          name: 'read_file',
          description: 'Прочитать файл',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      ],
    });

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      serverId: 'files',
      toolName: 'read_file',
      exposedName: 'mcp__files__read_file',
      description: 'Прочитать файл',
      readOnly: false,
    });
    expect(tools[0]!.inputSchema).toMatchObject({ type: 'object' });
  });

  it('пометка «только чтение» читается из annotations', () => {
    const tools = parseMcpTools('git', {
      tools: [{ name: 'log', annotations: { readOnlyHint: true } }],
    });
    expect(tools[0]!.readOnly).toBe(true);
  });

  it('без схемы подставляем пустой объект: вызов без аргументов лучше отсутствия', () => {
    const tools = parseMcpTools('x', { tools: [{ name: 'ping' }] });
    expect(tools[0]!.inputSchema).toEqual({ type: 'object', properties: {} });
    expect(tools[0]!.description).toBe('');
  });

  it('инструмент без имени пропускаем, мусор не роняет разбор', () => {
    expect(parseMcpTools('x', { tools: [{ description: 'без имени' }, null, 'строка'] })).toEqual([]);
    expect(parseMcpTools('x', null)).toEqual([]);
    expect(parseMcpTools('x', { tools: 'нет' })).toEqual([]);
  });

  it('одинаковые имена после чистки: берём первое', () => {
    const tools = parseMcpTools('s', { tools: [{ name: 'a.b' }, { name: 'a b' }] });
    expect(tools).toHaveLength(1);
    expect(tools[0]!.toolName).toBe('a.b');
  });
});

describe('mcpToolResultText', () => {
  it('склеивает текстовые части', () => {
    const result = mcpToolResultText({
      content: [
        { type: 'text', text: 'первая' },
        { type: 'text', text: 'вторая' },
      ],
    });
    expect(result).toEqual({ text: 'первая\nвторая', isError: false });
  });

  it('флаг ошибки сохраняется', () => {
    const result = mcpToolResultText({ isError: true, content: [{ type: 'text', text: 'файл не найден' }] });
    expect(result).toEqual({ text: 'файл не найден', isError: true });
  });

  it('картинку и ресурс показываем пометкой, а не байтами', () => {
    const result = mcpToolResultText({
      content: [
        { type: 'image', mimeType: 'image/png', data: 'AAAA' },
        { type: 'resource', resource: { uri: 'file:///tmp/x' } },
        { type: 'audio' },
      ],
    });
    expect(result.text).toBe('[изображение: image/png]\n[ресурс: file:///tmp/x]\n[аудио]');
  });

  it('структурированный ответ отдаём как JSON', () => {
    const result = mcpToolResultText({ structuredContent: { count: 3 } });
    expect(result.text).toBe('{"count":3}');
  });

  it('пустой ответ объясняем словами, а не пустой строкой', () => {
    expect(mcpToolResultText({ content: [] }).text).toBe('Инструмент не вернул текста');
    expect(mcpToolResultText({ isError: true, content: [] }).text).toBe('Инструмент вернул ошибку без описания');
    expect(mcpToolResultText(null).text).toBe('Инструмент не вернул содержимого');
  });
});

describe('normalizeMcpServers', () => {
  it('берёт только записи с командой, включённые по умолчанию', () => {
    const servers = normalizeMcpServers([
      { id: 'files', command: 'npx', args: ['-y', 'server-files'] },
      { id: 'без команды' },
      { command: 'нет имени' },
    ]);

    expect(servers).toEqual([{ id: 'files', command: 'npx', args: ['-y', 'server-files'], enabled: true }]);
  });

  it('имя чистится, дубли отбрасываются', () => {
    const servers = normalizeMcpServers([
      { id: 'my server', command: 'a' },
      { id: 'my__server', command: 'b' },
    ]);
    expect(servers).toHaveLength(1);
    expect(servers[0]!.id).toBe('my_server');
  });

  it('выключенный сервер остаётся в списке, но помечен', () => {
    const servers = normalizeMcpServers([{ id: 'x', command: 'node', enabled: false }]);
    expect(servers[0]!.enabled).toBe(false);
  });

  it('аргументы и окружение проверяются по типам', () => {
    const servers = normalizeMcpServers([
      { id: 'x', command: 'node', args: ['a', 5, null], env: { TOKEN: 'секрет', BAD: 7 } },
    ]);
    expect(servers[0]!.args).toEqual(['a']);
    expect(servers[0]!.env).toEqual({ TOKEN: 'секрет' });
  });

  it('не список — пустой список', () => {
    expect(normalizeMcpServers(null)).toEqual([]);
    expect(normalizeMcpServers({ id: 'x' })).toEqual([]);
  });
});

/** Инструмент для отбора: имя и сервер — всё, что важно потолкам. */
function tool(serverId: string, toolName: string): McpToolInfo {
  return {
    serverId,
    toolName,
    exposedName: exposedToolName(serverId, toolName),
    description: '',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
  };
}

describe('selectMcpTools', () => {
  it('потолки не трогают обычный набор', () => {
    const selection = selectMcpTools([tool('files', 'read'), tool('files', 'write'), tool('git', 'log')]);
    expect(selection.offered).toHaveLength(3);
    expect(selection.skipped).toBe(0);
    expect(selection.skippedByServer).toEqual({});
  });

  it('от одного сервера берёт не больше потолка', () => {
    const many = Array.from({ length: 30 }, (_, index) => tool('files', `t${String(index).padStart(2, '0')}`));
    const selection = selectMcpTools(many, { perServer: 5, total: 100 });

    expect(selection.offered).toHaveLength(5);
    expect(selection.skipped).toBe(25);
    expect(selection.skippedByServer.files).toBe(25);
    // Берём первые по алфавиту: набор не «прыгает» между шагами.
    expect(selection.offered.map((item) => item.toolName)).toEqual(['t00', 't01', 't02', 't03', 't04']);
  });

  it('общий потолок режет поперёк серверов', () => {
    const many = [
      ...Array.from({ length: 10 }, (_, index) => tool('a', `a${index}`)),
      ...Array.from({ length: 10 }, (_, index) => tool('b', `b${index}`)),
    ];
    const selection = selectMcpTools(many, { perServer: 100, total: 12 });

    expect(selection.offered).toHaveLength(12);
    expect(selection.skipped).toBe(8);
    // Серверы идут по алфавиту: из «a» возьмём все 10, из «b» — 2.
    expect(selection.skippedByServer).toEqual({ b: 8 });
  });

  it('порядок стабилен независимо от порядка входа', () => {
    const forward = selectMcpTools([tool('a', 'x'), tool('a', 'y'), tool('b', 'z')]);
    const backward = selectMcpTools([tool('b', 'z'), tool('a', 'y'), tool('a', 'x')]);
    expect(forward.offered.map((item) => item.exposedName)).toEqual(backward.offered.map((item) => item.exposedName));
  });

  it('потолки не могут обнулить набор', () => {
    // Ноль или отрицательное — ошибка вызова, а не «ничего не предлагать».
    expect(selectMcpTools([tool('a', 'x')], { perServer: 0, total: 0 }).offered).toHaveLength(1);
  });

  it('умолчания ограничивают, но не режут обычную установку', () => {
    expect(MAX_MCP_TOOLS).toBeGreaterThanOrEqual(32);
    const typical = Array.from({ length: 20 }, (_, index) => tool('files', `t${index}`));
    expect(selectMcpTools(typical).skipped).toBe(0);
  });
});
