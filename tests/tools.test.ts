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
      'list',
      'read',
      'search',
      'lsp',
      'run_tests',
      'checks',
      'edit',
      'file',
      'mind',
      'task',
      'browser',

      'mind',
      'mcp',
      'web',
      'show',
      'terminal',
    ];
    for (const name of dispatched) expect(byName.has(name)).toBe(true);
  });
});

describe('list', () => {
  it('папка без аргументов и маска с ними — в одной схеме', () => {
    const tool = byName.get('list')!;
    expect(tool.side).toBe('main');
    // Обязательных нет нарочно: без `path` — корень проекта, без `glob` — его файлы.
    // Выбор делает `listAction`, и оба действия только читают.
    expect(tool.inputSchema.required).toBeUndefined();
    expect(Object.keys(tool.inputSchema.properties)).toEqual(['path', 'glob', 'limit']);
  });
});

describe('read', () => {
  it('один файл и пачка — в одной схеме, без обязательных полей', () => {
    const tool = byName.get('read')!;
    expect(tool.side).toBe('main');
    expect(tool.inputSchema.required).toBeUndefined();
    expect(Object.keys(tool.inputSchema.properties)).toEqual(['path', 'paths', 'startLine', 'endLine', 'force']);
    expect(tool.inputSchema.properties.paths?.type).toBe('array');
    expect(tool.inputSchema.properties.paths?.items?.type).toBe('string');
  });
});

describe('search', () => {
  it('принимает регистр, режим «только файлы», контекст и предел выдачи', () => {
    const props = byName.get('search')!.inputSchema.properties;
    expect(Object.keys(props)).toEqual([
      'action',
      'query',
      'isRegex',
      'caseSensitive',
      'filesOnly',
      'glob',
      'path',
      'context',
      'limit',
      'uid',
    ]);
    expect(byName.get('search')!.inputSchema.required).toEqual(['query']);
    // Контекст — как -A/-B у grep: без него результат остаётся одной строкой.
    expect(props.context?.type).toBe('number');
    // Предел есть и в схеме: без него модель не могла попросить меньше двухсот
    // совпадений, и поиск отдавал десятки тысяч символов на любой запрос.
    expect(props.limit?.type).toBe('number');
    // `uid` — для действия `trace`: какой прогон разбирать. Беседа приходит из
    // uri найденной беседы, поэтому это первое, что видит модель после поиска.
    expect(props.uid?.type).toBe('string');
  });
});

describe('file: replace', () => {
  it('замена идёт действием и говорит, чего ей не хватает', () => {
    const tool = byName.get('file')!;
    expect(tool.side).toBe('main');
    // Обязательно только действие: остальное спрашивает само действие.
    expect(tool.inputSchema.required).toEqual(['action']);
    for (const name of ['query', 'replacement', 'isRegex', 'caseSensitive', 'glob']) {
      expect(Object.keys(tool.inputSchema.properties)).toContain(name);
    }
  });
});

describe('edit', () => {
  it('одна форма входа: правка по якорям плюс операции с файлом', () => {
    const tool = byName.get('edit')!;
    expect(tool.side).toBe('renderer');
    // Обязательных полей нет: `write` без `action` и `create` без `edits` — обе
    // формы живые; что именно нужно, говорит описание действия (п.42 TASKS.md).
    expect(tool.inputSchema.required).toEqual([]);
    expect(tool.inputSchema.properties.action?.enum).toEqual([
      'write',
      'create',
      'move',
      'delete',
    ]);
    expect(tool.description.toLowerCase()).toContain('oldtext');
    expect(tool.description.toLowerCase()).toContain('create');
  });

  it('схема описывает поля элемента, а не только «объект вообще»', () => {
    // Здесь и был баг: элемент массива объявлялся без полей, разбор же требовал
    // внутри path и правки. Модель, доверясь схеме, присылала замены без файла —
    // и вызов падал на «edits[0]: не задан path».
    const file = byName.get('edit')!.inputSchema.properties.edits!.items!;
    expect(file.properties?.path?.type).toBe('string');
    expect(file.properties?.edits?.type).toBe('array');
    // `required` у элемента нет намеренно: разбор принимает и вложенную форму,
    // и плоскую (`path` + `edits` без обёртки) — её модель слала чаще всего.
    expect(file.required).toBeUndefined();
    // У правки обязательна только замена: адрес — якорь `oldText`.
    const item = file.properties?.edits?.items?.properties;
    expect(item?.newText?.type).toBe('string');
    expect(item?.oldText?.type).toBe('string');
    // Позиции со схемы сняты — но разбор их понимает, это нужно старым беседам.
    expect(item?.startLine).toBeUndefined();
    expect(file.properties?.edits?.items?.required).toEqual(['newText']);
  });
});

describe('file', () => {
  it('требует и путь, и содержимое', () => {
    // Раньше `contents` было необязательным: забытое содержимое давало пустой
    // файл и отчёт «создан (0 строк)» — успех вместо ошибки.
    const tool = byName.get('file')!;
    expect(tool.side).toBe('main');
    expect(tool.inputSchema.required).toEqual(['action']);
    expect(tool.inputSchema.properties.contents?.type).toBe('string');
  });
});

describe('toOpenAiTools', () => {
  it('переносит имя и схему как есть', () => {
    const [first] = toOpenAiTools([byName.get('search')!]);
    expect(first!.type).toBe('function');
    expect(first!.function.name).toBe('search');
    expect(first!.function.parameters).toBe(byName.get('search')!.inputSchema);
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
    // 3 202: `run_background` слит с командой, длинные описания сокращены,
    // а язык схем — английский. Последнее дало больше всего: кириллица стоит
    // 2 символа на токен против 3.5, а человек описаний нигде не видит (в ленте —
    // имя, в окне «Прогон» — только параметры). Запас ≈ 300 — это 2-3 новых
    // инструмента; дальше разговор про бюджет, а не про «объясню подробнее».
    const tokens = estimateTextTokens(AGENT_TOOLS.map((tool) => tool.description).join(''));
    expect(tokens).toBeLessThan(3500);
  });
});
