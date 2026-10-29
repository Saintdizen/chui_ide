import { agentPrompt } from '../src/shared/agent-prompt';
import { AGENT_TOOLS, LINE_NUMBERING, type JsonSchema } from '../src/shared/tools';
import { describe, expect, it } from 'vitest';
import {
  describeShape,
  missingArguments,
  missingFieldsDetail,
  argumentsShape,
  toolSpec,
  wrongArguments,
} from '../src/shared/tool-schema';

/**
 * Проверка обязательных полей до исполнения. Поводом была живая ошибка: модель
 * присылала правку по якорю без `path` внутри элемента массива — схема такую форму
 * и разрешала (у массива было описание, но не было полей элемента), а разбор
 * аргументов ждал `path` и отвечал отказом из глубины.
 */

describe('toolSpec', () => {
  it('находит схему по имени', () => {
    expect(toolSpec('read')?.name).toBe('read');
  });

  it('чужое имя (MCP) не находит', () => {
    expect(toolSpec('mcp__foo__bar')).toBeUndefined();
  });
});

describe('missingArguments', () => {
  it('пустые аргументы — все обязательные поля перечислены', () => {
    const spec = toolSpec('search')!;
    expect(missingArguments(spec.inputSchema, {})).toEqual(['query']);
  });

  it('на месте — пустой список', () => {
    const spec = toolSpec('search')!;
    expect(missingArguments(spec.inputSchema, { query: 'x' })).toEqual([]);
  });

  it('null считается пропуском, пустая строка — нет', () => {
    // Пустую строку разбор понимает по-своему (например, «весь файл»), и
    // отвергать её здесь значило бы разойтись с ним.
    const spec = toolSpec('search')!;
    expect(missingArguments(spec.inputSchema, { query: null })).toEqual(['query']);
    expect(missingArguments(spec.inputSchema, { query: '' })).toEqual([]);
  });

  it('вложенный элемент массива называется с индексом', () => {
    // Проверяем индексацию вложенного массива, а не форму правки: она менялась.
    const spec = toolSpec('mind')!;
    const missing = missingArguments(spec.inputSchema, { action: 'steps', steps: [{ text: 'x' }] });
    expect(missing).toEqual(['steps[0].status']);
  });

  it('полная форма правки по якорю проходит', () => {
    const spec = toolSpec('edit')!;
    const args = { edits: [{ path: '/a.ts', edits: [{ oldText: 'a', newText: 'b' }] }] };
    expect(missingArguments(spec.inputSchema, args)).toEqual([]);
  });

  it('вложенный объект в правке тоже проверяется', () => {
    const spec = toolSpec('edit')!;
    const missing = missingArguments(spec.inputSchema, { edits: [{ path: '/a.ts', edits: [{ startLine: 1 }] }] });
    // Схема объявляет плоскую форму, старую вложенную знает только разбор:
    // проверка схемы её не разбирает и не требует чужих полей.
    expect(missing).toEqual([]);
  });

  it('у `edit` нет обязательных полей: без `edits` живут три действия из четырёх', () => {
    // `required: ['edits']` требовало вложенный массив у `create`/`move`/`delete`,
    // где его нет: форма обвиняла модель в том, чего схема сама не даёт.
    const spec = toolSpec('edit')!;
    expect(missingArguments(spec.inputSchema, { action: 'create', path: '/a.ts', contents: 'x' })).toEqual([]);
    expect(missingArguments(spec.inputSchema, { action: 'delete', path: '/a.ts' })).toEqual([]);
    expect(missingArguments(spec.inputSchema, { action: 'move', path: '/a.ts', to: '/b.ts' })).toEqual([]);
    // Плоская форма правки — тоже без отказа на этом уровне.
    expect(missingArguments(spec.inputSchema, { path: '/a.ts', edits: [{ oldText: 'a', newText: 'b' }] })).toEqual([]);
  });

  it('не-объект вместо элемента не роняет проверку', () => {
    const spec = toolSpec('edit')!;
    expect(missingArguments(spec.inputSchema, { edits: [{ path: '/a.ts', edits: ['строка'] }] })).toEqual([]);
  });

  it('у каждого терминального имени свои обязательные поля', () => {
    // Повод: ответ «нет поля id» приходил формой не того действия — `allOf` описывал
    // зависимость, но проверка его не читала. После развода имён поля — в самой схеме.
    const run = toolSpec('terminal')!;
    expect(missingArguments(run.inputSchema, {})).toEqual(['command']);
    const write = toolSpec('terminalWrite')!;
    expect(missingArguments(write.inputSchema, { id: 't1' })).toEqual(['data']);
    const stop = toolSpec('terminalStop')!;
    expect(missingArguments(stop.inputSchema, {})).toEqual(['id']);
    // У чтения и списка обязательных полей нет: пустой список — тоже ответ.
    expect(missingArguments(toolSpec('terminalOutput')!.inputSchema, {})).toEqual([]);
    expect(missingArguments(toolSpec('terminalList')!.inputSchema, {})).toEqual([]);
  });
});

/**
 * Значения `enum` до исполнения. Повод: `plan` (action steps) — статус шага был свободной строкой,
 * и `closed` вместо `done` уезжало в разбор, который таких значений не знает.
 */
describe('wrongArguments', () => {
  it('значение вне перечня названо вместе с допустимыми', () => {
    const spec = toolSpec('mind')!;
    const args = { action: 'steps', steps: [{ text: 'шаг', status: 'closed' }] };
    expect(wrongArguments(spec.inputSchema, args)).toEqual([
      { path: 'steps[0].status', value: 'closed', allowed: ['pending', 'in_progress', 'done'] },
    ]);
  });

  it('значение из перечня проходит', () => {
    const spec = toolSpec('mind')!;
    const args = { action: 'steps', steps: [{ text: 'шаг', status: 'done' }] };
    expect(wrongArguments(spec.inputSchema, args)).toEqual([]);
  });

  it('чужая форма аргумента не роняет проверку', () => {
    // Элемент массива — строка, а не объект: пусть об этом говорит разбор.
    const spec = toolSpec('edit')!;
    expect(wrongArguments(spec.inputSchema, { edits: ['строка'] })).toEqual([]);
  });
});

/**
 * Описания аргументов — постоянная часть запроса: они едут на каждом шаге прогона.
 * Поэтому у одного и того же аргумента одна и та же формулировка, а то, что верно
 * для всех инструментов сразу («пути абсолютные»), сказано в промпте один раз.
 */
describe('описания аргументов', () => {
  /** Все описания `path`/`paths` из всех схем: имя инструмента → текст. */
  function pathNotes(): Array<{ tool: string; name: string; text: string }> {
    const found: Array<{ tool: string; name: string; text: string }> = [];
    for (const tool of AGENT_TOOLS) {
      for (const [name, property] of Object.entries(tool.inputSchema.properties ?? {})) {
        if (name !== 'path' && name !== 'paths') continue;
        const text = (property as { description?: string }).description ?? '';
        found.push({ tool: tool.name, name, text });
      }
    }
    return found;
  }

  /** Допустимые формулировки. Список закрытый: новое слово поймает тест. */
  const CANONICAL = new Set([
    'Path.',
    'PNG, JPEG, WebP, GIF.',
    'Folder.',
    'Path, one file.',
    'File paths.',
    'Current path.',
    'New path.',
    'Narrow to a file; when the name is declared twice.',
    '2-5 files instead; output capped.',
    'references: narrow to a file. definition: the usage. outline: that file.',
    'One file or folder (diagnostics: open files; lint: whole project).',
    'One file (default: all open files).',
    'Folder or file (default: whole project).',
    'diff, log, blame: one file.',
    'One file instead of paths.',
    'Files instead of path.',
    'One file.',
    'Instead of path: 2-5 files.',
    'present: result files, 1–5, inside the project.',
    'stage, unstage, discard, commit: files/folders.',
    'Scope; glob from here.',
    'Path mask: ** any depth, * one segment. Without it, all files.',
  ]);

  it('путь описан одинаково везде, где он есть', () => {
    const notes = pathNotes();
    expect(notes.length).toBeGreaterThan(5);
    // Одно и то же описание — одна фраза: список закрытый, синоним — уже новое слово.
    // Основная доля — один и тот же «Path.»; уточнения живут только там, где
    // действительно добавляют смысл (маска, диапазон, «один файл вместо списка»).
    // Путь часто и есть единственный аргумент (read, show): там он зовётся по-своему.
    expect(notes.filter((note) => note.text === 'Path.').length).toBeGreaterThanOrEqual(2);
    for (const note of notes) {
      expect(CANONICAL.has(note.text), `${note.tool}.${note.name}: ${note.text}`).toBe(true);
    }
  });

  it('форма вызова в отказе называет вложенность', () => {
    // Живой промах: правка ушла плоской (`{path, edits: [{oldText, newText}]}`),
    // а схема ждёт обёртку `edits: [{path, edits: [...]}]`. Отказ называл
    // `edits[0].path`, но не говорил, куда его класть, — и промах стоил шага.
    const edit = toolSpec('edit');
    if (!edit) throw new Error('нет схемы edit');
    const shape = describeShape(edit.inputSchema);
    expect(shape).toContain('edits');
    expect(shape).toContain('edits?: [{path');
    // `?` появились после того, как `required` в `edit` опустел: иначе `create`
    // обязан был притащить `edits`, которого у него нет (п.42 TASKS.md). Форма
    // вызова от этого честнее: отказ говорит, какие поля необязательны.
    // Подсказка стоит токенов только в отказе: в задании её нет.
    expect(agentPrompt('auto', { confirm: false })).not.toContain('Форма:');
  });

  /**
   * Как считаются строки — тоже постоянная часть запроса, и путаница тут стоила
   * шага: `show.open.line` шёл в редактор, а `read` печатал свои номера, и модель
   * верила, что счёт общий. Теперь у каждой схемы, где строки вообще есть, одна
   * формулировка — `LINE_NUMBERING`; закрытый список ловит новое слово.
   */
  it('строки везде считаются с единицы и это сказано одинаково', () => {
    const CANONICAL_LINE = new Set([
      LINE_NUMBERING,
      `First line; ${LINE_NUMBERING}`,
      // С 27.10 это КОНСТАНТА, а не `LINE_NUMBERING`: полная формулировка («Lines
      // and columns are 1-based, the same as read prints them.») тянула 15 токенов
      // в каждый запрос ради того, что модель знает и так. "1-based" держит
      // главный риск (счёт с нуля vs с единицы) за 2 токена.
      'First line. 1-based.',
      'Last line, inclusive.',
      `open: line. ${LINE_NUMBERING}`,
      `open, present: line. ${LINE_NUMBERING}`,
      `open, present: column. ${LINE_NUMBERING}`,
      `open: column. ${LINE_NUMBERING}`,
      `definition: usage line. ${LINE_NUMBERING}`,
      `definition: column. ${LINE_NUMBERING}`,
    ]);

    const notes = AGENT_TOOLS.flatMap((tool) =>
      Object.entries(tool.inputSchema.properties ?? {})
        .filter(([name]) => /line|column/i.test(name))
        .map(([name, property]) => ({
          tool: tool.name,
          name,
          text: (property as { description?: string }).description ?? '',
        })),
    );

    expect(notes.length).toBeGreaterThan(3);
    for (const note of notes) {
      expect(CANONICAL_LINE.has(note.text), `${note.tool}.${note.name}: ${note.text}`).toBe(true);
    }

    // Формулировка живёт в одном месте: схема не переписывает счёт своими словами.
    expect(LINE_NUMBERING).toMatch(/1-based/);
  });

  it('«Absolute» из схем ушло в промпт', () => {
    // Тринадцать повторов «Absolute path…» стоили дороже одного совета в промпте,
    // и совет к тому же не забывается в ростере, где схемы нет.
    const all = AGENT_TOOLS.flatMap((tool) =>
      Object.values(tool.inputSchema.properties ?? {}).map(
        (property) => (property as { description?: string }).description ?? '',
      ),
    );
    expect(all.filter((text) => /absolute/i.test(text))).toEqual([]);
    expect(agentPrompt('full', { confirm: false })).toContain('абсолютные');
  });
});

describe('wrongArguments: перечни внутри вложенных полей', () => {
  it('промах внутри элемента массива назван путём с индексом', () => {
    // Именно этот случай увидит модель после вызова `mind steps` с недопустимым
    // `status`: отказ должен назвать место, а не пересказывать всю схему.
    const spec = toolSpec('mind')!;
    const wrong = wrongArguments(spec.inputSchema, {
      action: 'steps',
      steps: [
        { text: 'x', status: 'done' },
        { text: 'y', status: 'сделано' },
      ],
    });
    expect(wrong).toEqual([{ path: 'steps[1].status', value: 'сделано', allowed: ['pending', 'in_progress', 'done'] }]);
  });

  it('верное значение во вложенном поле промахом не считается', () => {
    const spec = toolSpec('mind')!;
    const args = { action: 'steps', steps: [{ text: 'x', status: 'in_progress' }] };
    expect(wrongArguments(spec.inputSchema, args)).toEqual([]);
  });

  it('не-объект вместо элемента не роняет проверку', () => {
    const spec = toolSpec('mind')!;
    expect(wrongArguments(spec.inputSchema, { action: 'steps', steps: ['строка', 7, null] })).toEqual([]);
  });

  it('чужое действие с перечнем названо вместе с допустимыми', () => {
    const spec = toolSpec('mind')!;
    const action = spec.inputSchema.properties?.action as { enum: string[] } | undefined;
    expect(wrongArguments(spec.inputSchema, { action: 'телеметрия' })).toEqual([
      {
        path: 'action',
        value: 'телеметрия',
        allowed: action?.enum,
      },
    ]);
  });
});

describe('тексты отказа', () => {
  it('missingFieldsDetail называет поле вместе с типом', () => {
    const spec = toolSpec('edit')!;
    const detail = missingFieldsDetail('edit', spec.inputSchema, ['edits']);
    expect(detail).toBe('Аргументы edit: нужны edits: array');
  });

  it('missingFieldsDetail приписывает перечень, если он есть у поля', () => {
    const spec = toolSpec('mind')!;
    const detail = missingFieldsDetail('mind', spec.inputSchema, ['action']);
    expect(detail).toMatch(/^Аргументы mind: нужны action: string=[a-z_|]+$/);
  });

  it('путь, которого нет в схеме, называется как есть: пустое лучше неверного', () => {
    const spec = toolSpec('edit')!;
    expect(missingFieldsDetail('edit', spec.inputSchema, ['edits[0].чего-то'])).toContain('edits[0].чего-то');
  });

  it('argumentsShape перечисляет поля верхнего уровня и помечает необязательные', () => {
    const spec = toolSpec('read')!;
    const shape = argumentsShape(spec.inputSchema);
    expect(shape.startsWith('{')).toBe(true);
    expect(shape).toContain('path?:string');
  });
});

describe('вложенные объекты в схеме', () => {
  const nested: JsonSchema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      box: {
        type: 'object',
        required: ['mode'],
        properties: { mode: { type: 'string', enum: ['a', 'b'] } },
      },
    },
    required: ['id'],
  };

  it('missingArguments доходит до обязательного поля вложенного объекта', () => {
    expect(missingArguments(nested, { id: 'x', box: { mode: 'a' } })).toEqual([]);
    expect(missingArguments(nested, { id: 'x', box: {} })).toEqual(['box.mode']);
  });

  it('wrongArguments называет промах внутри вложенного объекта', () => {
    expect(wrongArguments(nested, { id: 'x', box: { mode: 'c' } })).toEqual([
      { path: 'box.mode', value: 'c', allowed: ['a', 'b'] },
    ]);
  });

  it('argumentsShape показывает вложенный объект', () => {
    expect(argumentsShape(nested)).toContain('box?: {');
  });
});

describe('условные требования (allOf)', () => {
  // Ни один из наших инструментов этого пока не использует — проверка написана
  // на синтетической схеме, чтобы ветка не гнила непроверенной.
  const conditional: JsonSchema = {
    type: 'object',
    properties: { action: { type: 'string', enum: ['read', 'clear'] }, id: { type: 'string' } },
    required: ['action'],
    // biome-ignore lint/suspicious/noThenProperty: `then` здесь ключ JSON-Schema, а не thenable.
    allOf: [{ if: { properties: { action: { enum: ['read'] } } }, then: { required: ['id'] } }],
  };

  it('id требуется только для read', () => {
    expect(missingArguments(conditional, { action: 'read' })).toEqual(['id']);
    expect(missingArguments(conditional, { action: 'clear' })).toEqual([]);
    expect(missingArguments(conditional, { action: 'read', id: 'job-1' })).toEqual([]);
  });

  it('условие по const тоже работает', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { mode: { type: 'string' }, file: { type: 'string' } },
      // biome-ignore lint/suspicious/noThenProperty: `then` здесь ключ JSON-Schema, а не thenable.
      allOf: [{ if: { properties: { mode: { const: 'file' } } }, then: { required: ['file'] } }],
    };
    expect(missingArguments(schema, { mode: 'file' })).toEqual(['file']);
    expect(missingArguments(schema, { mode: 'text' })).toEqual([]);
  });
});
