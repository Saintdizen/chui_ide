import { describe, expect, it } from 'vitest';
import { canonicalCall } from '../src/shared/tool-aliases';
import { AGENT_TOOLS } from '../src/shared/tools';

/** Схемы по нынешним именам: псевдоним обязан приводить к существующему. */
// Множество строк, а не имён: сравниваем с именем, которое вернул псевдоним, — оно может
// и не быть известным именем, и именно это проверяется.
const names = new Set<string>(AGENT_TOOLS.map((tool) => tool.name));

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

  it('rename_symbol стал действием lsp с тем же смыслом', () => {
    // Имя было отдельным только потому, что пишет код; теперь это `action`, а
    // различие держит `writeActions` в политике. Старые вызовы не отваливаются.
    const call = canonicalCall('rename_symbol', '{"symbol":"a","newName":"b"}');
    expect(call.name).toBe('lsp');
    expect(call.renamed).toBe(true);
    expect(JSON.parse(call.arguments)).toEqual({ symbol: 'a', newName: 'b', action: 'rename' });
  });
});

describe('слияния с другим аргументом: поиск', () => {
  it('codebase_search и search_docs стали действиями search', () => {
    // Четыре имени различались первой строкой описания, а тело схемы у них было
    // одно. Живые прогоны зовут семейство по имени `search` — старое не должно
    // упираться в тупик, продолжая сохранённую беседу.
    const code = canonicalCall('codebase_search', '{"query":"SessionIndex"}');
    expect(code.name).toBe('search');
    expect(JSON.parse(code.arguments)).toEqual({ query: 'SessionIndex', action: 'code' });

    const docs = canonicalCall('search_docs', '{"query":"права"}');
    expect(docs.name).toBe('search');
    expect(JSON.parse(docs.arguments)).toEqual({ query: 'права', action: 'docs' });
  });

  it('session_search и session_trace ведут к history, а не к search', () => {
    // Журнал разговоров — не поиск по проекту: `sessions`/`trace` переехали в своё имя.
    const sessions = canonicalCall('session_search', '{"query":"индекс"}');
    expect(sessions.name).toBe('history');
    expect(JSON.parse(sessions.arguments)).toEqual({ query: 'индекс', action: 'sessions' });
    const trace = canonicalCall('session_trace', '{"uid":"a1"}');
    expect(trace.name).toBe('history');
    expect(JSON.parse(trace.arguments)).toEqual({ uid: 'a1', action: 'trace' });
  });

  it('find_files и list_dir ведут к list: просмотр имён — один инструмент', () => {
    expect(canonicalCall('find_files', '{"glob":"**/*.ts"}').name).toBe('list');
    expect(canonicalCall('list_dir', '{"path":"/src"}').name).toBe('list');
  });
});

describe('что псевдоним не трогает', () => {
  it('нынешнее имя возвращается как есть', () => {
    const call = canonicalCall('edit', '{"action":"write"}');
    expect(call.renamed).toBe(false);
    expect(call.arguments).toBe('{"action":"write"}');
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
    for (const old of ['remember', 'forget']) {
      expect(names.has(canonicalCall(old, '{}').name), old).toBe(true);
    }
    for (const old of ['file_outline', 'find_references', 'go_to_definition']) {
      expect(names.has(canonicalCall(old, '{}').name), old).toBe(true);
    }
    for (const old of ['codebase_search', 'search_docs', 'session_search', 'session_trace', 'find_files']) {
      expect(names.has(canonicalCall(old, '{}').name), old).toBe(true);
    }
  });
});

describe('слияния с действием: терминал', () => {
  it('run_terminal, run_output, run_stop — три действия одного terminal', () => {
    // 47 вызовов `run_terminal` в трёх беседах: имя живёт в истории, и модель его
    // копирует. Без псевдонима — шаг в «Инструмент недоступен».
    const rest = canonicalCall('run_terminal', '{"command":"npm t"}');
    expect(rest.name).toBe('terminal');
    // Действие по умолчанию — запуск: старое имя его не называло.
    expect(JSON.parse(rest.arguments)).toEqual({ command: 'npm t', action: 'run' });
    expect(JSON.parse(canonicalCall('run_output', '{"id":"3"}').arguments)).toEqual({
      id: '3',
      action: 'output',
    });
    expect(JSON.parse(canonicalCall('run_stop', '{"id":"3"}').arguments)).toEqual({
      id: '3',
      action: 'stop',
    });
  });

  it('псевдонимы ведут к существующей схеме', () => {
    for (const old of ['run_terminal', 'run_output', 'run_stop']) {
      expect(names.has(canonicalCall(old, '{}').name), old).toBe(true);
    }
  });
});

describe('правка по якорю под старыми именами', () => {
  it('str_replace — та же плоская форма, что у edit', () => {
    const args = '{"path":"/a.ts","oldText":"a","newText":"b"}';
    const call = canonicalCall('str_replace', args);
    expect(call.name).toBe('edit');
    expect(call.renamed).toBe(true);
    // Переименовывать нечего: поля те же.
    expect(call.arguments).toBe(args);
  });

  it('apply_patch: patches на двух уровнях — это edits', () => {
    // Форма старого вызова: `{ patches: [{ path, patches: [{ oldText, newText }] }] }`.
    // У `edit` те же поля под именем `edits` — на обоих уровнях.
    const call = canonicalCall(
      'apply_patch',
      JSON.stringify({ patches: [{ path: '/a.ts', patches: [{ oldText: 'a', newText: 'b' }] }] }),
    );
    expect(call.name).toBe('edit');
    expect(call.renamed).toBe(true);
    expect(JSON.parse(call.arguments)).toEqual({ edits: [{ path: '/a.ts', edits: [{ oldText: 'a', newText: 'b' }] }] });
  });

  it('битые аргументы старого имени доезжают как есть', () => {
    // Разберётся инструмент и скажет, что именно не так: молча терять текст нельзя.
    expect(canonicalCall('apply_patch', '{битый').arguments).toBe('{битый');
  });
});
