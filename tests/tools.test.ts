import { describe, expect, it } from 'vitest';
import { AGENT_TOOLS, toOpenAiTools, type AgentToolName } from '../src/shared/tools';

const byName = new Map(AGENT_TOOLS.map((tool) => [tool.name, tool]));

describe('набор инструментов агента', () => {
  it('имена уникальны', () => {
    expect(byName.size).toBe(AGENT_TOOLS.length);
  });

  it('каждый инструмент описывает схему-объект и место исполнения', () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool.inputSchema.type).toBe('object');
      expect(['main', 'renderer']).toContain(tool.side);
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it('обязательные поля схемы присутствуют в properties', () => {
    for (const tool of AGENT_TOOLS) {
      for (const required of tool.inputSchema.required ?? []) {
        expect(Object.keys(tool.inputSchema.properties)).toContain(required);
      }
    }
  });

  it('инструменты, о которых знает диспатчер, описаны', () => {
    // Список сверяем с `runTool`: имя, которое он умеет, обязано быть в наборе.
    const dispatched: AgentToolName[] = [
      'list_dir',
      'read_file',
      'read_files',
      'search',
      'find_files',
      'get_diagnostics',
      'apply_edit',
      'replace_in_files',
      'run_terminal',
      'create_file',
      'delete_file',
      'move_file',
      'update_plan',
      'git_status',
      'git_diff',
      'git_log',
      'open_file',
      'terminal_list',
      'terminal_start',
      'terminal_read',
      'terminal_write',
      'terminal_stop',
    ];
    for (const name of dispatched) expect(byName.has(name)).toBe(true);
  });
});

describe('find_files', () => {
  it('главная сторона и необязательные аргументы', () => {
    const tool = byName.get('find_files')!;
    expect(tool.side).toBe('main');
    expect(tool.inputSchema.required).toBeUndefined();
    expect(Object.keys(tool.inputSchema.properties)).toEqual(['glob', 'limit']);
  });
});

describe('search', () => {
  it('принимает регистр и режим «только файлы»', () => {
    const props = byName.get('search')!.inputSchema.properties;
    expect(Object.keys(props)).toEqual(['query', 'isRegex', 'caseSensitive', 'filesOnly', 'glob']);
    expect(byName.get('search')!.inputSchema.required).toEqual(['query']);
  });
});

describe('read_files', () => {
  it('требует непустой список путей', () => {
    const tool = byName.get('read_files')!;
    expect(tool.side).toBe('main');
    expect(tool.inputSchema.required).toEqual(['paths']);
    expect(tool.inputSchema.properties.paths?.type).toBe('array');
    expect(tool.inputSchema.properties.paths?.items?.type).toBe('string');
  });
});

describe('replace_in_files', () => {
  it('пишет в main и требует запрос и замену', () => {
    const tool = byName.get('replace_in_files')!;
    expect(tool.side).toBe('main');
    expect(tool.inputSchema.required).toEqual(['query', 'replacement']);
    expect(Object.keys(tool.inputSchema.properties)).toEqual([
      'query',
      'replacement',
      'isRegex',
      'caseSensitive',
      'glob',
    ]);
  });
});

describe('git_log', () => {
  it('главная сторона, read-only аргументы', () => {
    const tool = byName.get('git_log')!;
    expect(tool.side).toBe('main');
    expect(Object.keys(tool.inputSchema.properties)).toEqual(['limit', 'path']);
  });
});

describe('toOpenAiTools', () => {
  it('переносит имя и схему как есть', () => {
    const [first] = toOpenAiTools([byName.get('find_files')!]);
    expect(first!.type).toBe('function');
    expect(first!.function.name).toBe('find_files');
    expect(first!.function.parameters).toBe(byName.get('find_files')!.inputSchema);
  });
});
