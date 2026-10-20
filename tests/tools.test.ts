import { describe, expect, it } from 'vitest';
import { estimateTextTokens } from '../src/shared/context-fit';
import { AGENT_TOOLS, parseToolArguments, toOpenAiTools, type AgentToolName } from '../src/shared/tools';

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
      'codebase_search',
      'search_docs',
      'read_skill',
      'find_references',
      'go_to_definition',
      'rename_symbol',
      'run_tests',
      'find_files',
      'get_diagnostics',
      'apply_edit',
      'apply_patch',
      'replace_in_files',
      'workflow',
      'run_terminal',
      'run_output',
      'run_stop',
      'create_file',
      'delete_file',
      'move_file',
      'update_plan',
      'ask',
      'task',
      'browser_open',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_evaluate',
      'browser_zoom',
      'browser_close',
      'remember',
      'forget',
      'schedule_create',
      'schedule_list',
      'schedule_update',
      'schedule_delete',
      'git_status',
      'git_diff',
      'git_log',
      'git_blame',
      'git_stage',
      'git_unstage',
      'git_commit',
      'git_checkout',
      'git_discard',
      'git_fetch',
      'git_pull',
      'git_push',
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
  it('принимает регистр, режим «только файлы» и контекст вокруг совпадения', () => {
    const props = byName.get('search')!.inputSchema.properties;
    expect(Object.keys(props)).toEqual(['query', 'isRegex', 'caseSensitive', 'filesOnly', 'glob', 'path', 'context']);
    expect(byName.get('search')!.inputSchema.required).toEqual(['query']);
    // Контекст — как -A/-B у grep: без него результат остаётся одной строкой.
    expect(props.context?.type).toBe('number');
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

describe('apply_patch', () => {
  it('правки по якорю живут в renderer и не требуют позиций', () => {
    const tool = byName.get('apply_patch')!;
    expect(tool.side).toBe('renderer');
    expect(tool.inputSchema.required).toEqual(['patches']);
    // В схеме нет ни строк, ни столбцов: позиции считает документ.
    expect(tool.inputSchema.properties).toEqual({
      patches: expect.objectContaining({ type: 'array' }),
    });
    // Описания схем — по-английски (их читает только модель), поэтому ищем смысл:
    // якорная правка, а не правка по номерам строк.
    expect(tool.description.toLowerCase()).toContain('anchor');
  });

  it('схема описывает поля элемента, а не только «объект вообще»', () => {
    // Здесь и был баг: элемент массива объявлялся без полей, разбор же требовал
    // внутри path и patches. Модель, доверясь схеме, присылала замены без файла —
    // и вызов падал на «patches[0]: не задан path».
    const patches = byName.get('apply_patch')!.inputSchema.properties.patches!;
    const file = patches.items!;
    expect(file.properties?.path?.type).toBe('string');
    expect(file.properties?.patches?.type).toBe('array');
    expect(file.required).toEqual(['path', 'patches']);
    // Якорь — пара oldText/newText, обе обязательны.
    expect(file.properties?.patches?.items?.required).toEqual(['oldText', 'newText']);
    expect(file.properties?.patches?.items?.properties?.newText?.type).toBe('string');
  });
});

describe('apply_edit', () => {
  it('схема описывает и правку внутри файла — у них была та же дыра', () => {
    const edits = byName.get('apply_edit')!.inputSchema.properties.edits!;
    const file = edits.items!;
    expect(file.required).toEqual(['path', 'edits']);
    expect(file.properties?.edits?.items?.required).toContain('newText');
    expect(file.properties?.edits?.items?.properties?.startLine?.type).toBe('number');
  });
});

describe('create_file', () => {
  it('требует и путь, и содержимое', () => {
    // Раньше `contents` было необязательным: забытое содержимое давало пустой
    // файл и отчёт «создан (0 строк)» — успех вместо ошибки.
    const tool = byName.get('create_file')!;
    expect(tool.side).toBe('main');
    expect(tool.inputSchema.required).toEqual(['path', 'contents']);
    expect(tool.inputSchema.properties.contents?.type).toBe('string');
  });
});

describe('git_log', () => {
  it('главная сторона, read-only аргументы', () => {
    const tool = byName.get('git_log')!;
    expect(tool.side).toBe('main');
    expect(Object.keys(tool.inputSchema.properties)).toEqual(['limit', 'path']);
  });
});

describe('git-записи', () => {
  it('все меняют репозиторий и живут в main', () => {
    const writes: AgentToolName[] = [
      'git_stage',
      'git_unstage',
      'git_commit',
      'git_checkout',
      'git_discard',
      'git_fetch',
      'git_pull',
      'git_push',
    ];
    for (const name of writes) {
      const tool = byName.get(name)!;
      expect(tool.side).toBe('main');
    }
  });

  it('git_commit требует сообщение, git_stage — пути', () => {
    expect(byName.get('git_commit')!.inputSchema.required).toEqual(['message']);
    expect(byName.get('git_stage')!.inputSchema.required).toEqual(['paths']);
  });

  it('git_fetch и git_pull без аргументов, git_push — только флаги', () => {
    expect(byName.get('git_fetch')!.inputSchema.required).toBeUndefined();
    expect(byName.get('git_pull')!.inputSchema.required).toBeUndefined();
    expect(Object.keys(byName.get('git_push')!.inputSchema.properties)).toEqual(['setUpstream', 'force']);
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

describe('parseToolArguments', () => {
  it('пустая строка — пустой объект, а не ошибка', () => {
    expect(parseToolArguments('')).toEqual({ ok: true, value: {} });
    expect(parseToolArguments('   ')).toEqual({ ok: true, value: {} });
  });

  it('корректный JSON-объект разбирается', () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('JSON не-объект отвергается', () => {
    for (const raw of ['[1,2]', '"str"', '123', 'null', 'true']) {
      const result = parseToolArguments(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('JSON-объектом');
    }
  });

  it('битый JSON не роняет цикл, а возвращает текст ошибки', () => {
    const result = parseToolArguments('{не json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('разобрать');
  });
});

describe('вес описаний — под присмотром', () => {
  /**
   * Описания уезжают модели в КАЖДОМ запросе, а прогон агента делает их десяток.
   * Набор давно перевалил за полсотни схем, и до этой проверки одни описания весили около
   * 6 200 токенов: половина из них повторяла правила из `AGENT_PROMPT`
   * («прежде чем читать файл целиком — поищи», «context=2–3»).
   *
   * Правило теперь одно: в описании — что инструмент делает, что вернёт и жёсткое
   * ограничение. Когда брать инструмент и что делать при промахе, живёт в
   * системном промпте (`AGENT_PROMPT` в `src/main/ai/service.ts`), и только там.
   */
  it('ни одно описание не длиннее 400 символов', () => {
    const long = AGENT_TOOLS.filter((tool) => tool.description.length > 400).map((tool) => ({
      name: tool.name,
      length: tool.description.length,
    }));
    expect(long).toEqual([]);
  });

  it('все описания вместе влезают в 3 500 токенов', () => {
    // Меряем той же ставкой, что и main (`estimateTextTokens`): описания читает
    // только модель, но едут они в каждом запросе. Замер на момент проверки —
    // 3 202: `run_background` слит с `run_terminal`, длинные описания сокращены,
    // а язык схем — английский. Последнее дало больше всего: кириллица стоит
    // 2 символа на токен против 3.5, а человек описаний нигде не видит (в ленте —
    // имя, в окне «Прогон» — только параметры). Запас ≈ 300 — это 2-3 новых
    // инструмента; дальше разговор про бюджет, а не про «объясню подробнее».
    const tokens = estimateTextTokens(AGENT_TOOLS.map((tool) => tool.description).join(''));
    expect(tokens).toBeLessThan(3500);
  });
});
