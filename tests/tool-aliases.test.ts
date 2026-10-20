import { describe, expect, it } from 'vitest';
import { canonicalCall } from '../src/shared/tool-aliases';
import { AGENT_TOOLS } from '../src/shared/tools';

/** Схемы по нынешним именам: псевдоним обязан приводить к существующему. */
const names = new Set(AGENT_TOOLS.map((tool) => tool.name));

describe('старые имена инструментов', () => {
  it('read_file, read_files, list_dir, find_files меняются на read и list', () => {
    expect(canonicalCall('read_file', '{"path":"/a.ts"}').name).toBe('read');
    expect(canonicalCall('read_files', '{"paths":["/a.ts"]}').name).toBe('read');
    expect(canonicalCall('list_dir', '{"path":"/src"}').name).toBe('list');
    expect(canonicalCall('find_files', '{"glob":"**/*.ts"}').name).toBe('list');
  });

  it('аргументы переезжают без потерь', () => {
    const args = '{"path":"/a.ts","startLine":3,"endLine":9}';
    expect(canonicalCall('read_file', args).arguments).toBe(args);
  });
});

describe('слияния с другим аргументом: агенты', () => {
  it('старое имя агента превращается в agents плюс действие', () => {
    // Пять имён стали одним инструментом с `action`. Вызов из сохранённой
    // беседы должен дойти до него, а не получить «Инструмент недоступен».
    const spawn = canonicalCall('spawn_agent', '{"prompt":"найди"}');
    expect(spawn.name).toBe('agents');
    expect(spawn.renamed).toBe(true);
    expect(JSON.parse(spawn.arguments)).toEqual({ prompt: 'найди', action: 'spawn' });
    expect(JSON.parse(canonicalCall('interrupt_agent', '{"id":"agent-1"}').arguments)).toEqual({
      id: 'agent-1',
      action: 'interrupt',
    });
  });

  it('своё действие старое имя не отменяет', () => {
    const mapped = canonicalCall('wait_agent', '{"action":"list","timeout":5}');
    expect(mapped.name).toBe('agents');
    expect(JSON.parse(mapped.arguments).action).toBe('list');
  });
});

describe('слияния с другим аргументом: память', () => {
  it('remember и forget — два действия одного mind', () => {
    // Заметки из старых бесед должны дойти: имена стали действиями.
    const remember = canonicalCall('remember', '{"text":"pytest"}');
    expect(remember.name).toBe('mind');
    expect(remember.renamed).toBe(true);
    expect(JSON.parse(remember.arguments)).toEqual({ text: 'pytest', action: 'remember' });
    expect(JSON.parse(canonicalCall('forget', '{"query":"pytest"}').arguments)).toEqual({
      query: 'pytest',
      action: 'forget',
    });
  });

  it('своё действие старое имя не отменяет', () => {
    const mapped = canonicalCall('forget', '{"action":"remember","text":"x"}');
    expect(mapped.name).toBe('mind');
    expect(JSON.parse(mapped.arguments).action).toBe('remember');
  });
});

describe('слияния с другим аргументом: языковой сервер', () => {
  it('file_outline стал действием lsp', () => {
    // Скелет файла — тот же сервер, что ссылки и объявление: имя ушло в action.
    const call = canonicalCall('file_outline', '{"path":"/a.ts"}');
    expect(call.name).toBe('lsp');
    expect(call.renamed).toBe(true);
    expect(JSON.parse(call.arguments)).toEqual({ path: '/a.ts', action: 'outline' });
  });
});

describe('что псевдоним не трогает', () => {
  it('нынешнее имя возвращается как есть', () => {
    const call = canonicalCall('agents', '{"action":"list"}');
    expect(call.renamed).toBe(false);
    expect(call.arguments).toBe('{"action":"list"}');
  });

  it('чужое имя (MCP) остаётся чужим', () => {
    const call = canonicalCall('mcp__files__read', '{}');
    expect(call.name).toBe('mcp__files__read');
    expect(call.renamed).toBe(false);
  });

  it('каждый псевдоним ведёт к существующей схеме', () => {
    for (const old of ['read_file', 'read_files', 'list_dir', 'find_files']) {
      expect(names.has(canonicalCall(old, '{}').name), old).toBe(true);
    }
    for (const old of ['spawn_agent', 'list_agents', 'wait_agent', 'send_message', 'interrupt_agent']) {
      expect(names.has(canonicalCall(old, '{}').name), old).toBe(true);
    }
    for (const old of ['remember', 'forget']) {
      expect(names.has(canonicalCall(old, '{}').name), old).toBe(true);
    }
    for (const old of ['file_outline', 'find_references', 'go_to_definition']) {
      expect(names.has(canonicalCall(old, '{}').name), old).toBe(true);
    }
  });
});
