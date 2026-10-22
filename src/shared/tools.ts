/**
 * Описание инструментов агента: какие действия ассистент может вызывать и где
 * они исполняются.
 *
 * `side` — принципиальный момент архитектуры: файловые операции живут в main
 * (там есть доступ к ФС), а правки документов — в renderer (там документная
 * модель и undo). Мост между ними уже готов — это RPC + события.
 *
 * Реализованы все: list, read, search и terminal — в main,
 * edit — в renderer через хостовый вызов. Какие из них предложить модели,
 * решает сборка: см. `canRun` в `src/main/ai/service.ts`.
 */

export type AgentToolSide = 'main' | 'renderer';

export type AgentToolName =
  | 'list'
  | 'read'
  | 'search'
  | 'history'
  | 'read_image'
  | 'lsp'
  | 'project_map'
  | 'checks'
  | 'run_tests'
  | 'mcp'
  | 'edit'
  | 'terminal'
  | 'web'
  | 'file'
  | 'mind'
  | 'task'
  | 'browser'
  | 'show';

export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  /**
   * Необязательно: у вложенного узла (`items`, поля объекта) структура видна по
   * именам полей и `required`, а пересказ её словами — это токены на каждом шаге.
   */
  description?: string;
  items?: JsonSchemaProperty;
  /**
   * Поля вложенного объекта. Нужны там, где элемент массива — объект со своими
   * обязательными полями (обе формы `edit`): без них схема обещает
   * модели «объект неизвестной формы», а разбор аргументов ждёт конкретные поля —
   * и вызов падает на «не задан path» у формы, которую сама схема и разрешала.
   */
  properties?: Record<string, JsonSchemaProperty>;
  /** Обязательные поля вложенного объекта. */
  required?: string[];
  enum?: string[];
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

/**
 * Минимум, нужный, чтобы предложить инструмент модели. Есть и у наших
 * инструментов, и у внешних (MCP): их схемы приходят от чужой программы и в
 * `JsonSchema` не помещаются, а `toOpenAiTools` отдаёт схему как есть.
 */
export interface ExposedToolSpec {
  name: string;
  description: string;
  inputSchema: object;
}

export interface AgentToolSpec extends ExposedToolSpec {
  name: AgentToolName;
  side: AgentToolSide;
  inputSchema: JsonSchema;
}

export const AGENT_TOOLS: readonly AgentToolSpec[] = [
  {
    name: 'list',
    side: 'main',
    description:
      'What is there: `path` lists a folder, `glob` finds files by mask (**/*.py, src/**). ' +
      'Service folders (node_modules, .git, dist) are skipped.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Folder.' },
        glob: {
          type: 'string',
          description: 'Mask: ** any depth, * one segment. Default: all.',
        },
        limit: { type: 'number', description: 'Cap on entries.' },
      },
    },
  },
  {
    name: 'read',
    side: 'main',
    description:
      'Read a file — whole, a line range (`startLine`/`endLine`) or several at once (`paths`). ' +
      'Prefer a range around the spot: a whole file costs more than the answer needs. ' +
      'Output lines are numbered from 1: those numbers go to edit.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'One file.' },
        paths: {
          type: 'array',
          description: '2-5 files instead; output capped.',
          items: { type: 'string' },
        },
        startLine: {
          type: 'number',
          description: 'First line, 1-based.',
        },
        endLine: {
          type: 'number',
          description: 'Last line, inclusive.',
        },
        force: {
          type: 'boolean',
          description: 'Re-read (same turn).',
        },
      },
    },
  },
  {
    name: 'search',
    side: 'main',
    description: 'Project search: text and code declarations.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['text', 'code', 'docs'],
          // Смысл действий — здесь же, рядом с enum: в шапке он дублировался
          // и стоил токенов в каждом запросе.
          description: 'text: path, line, match; code: declarations; docs: documentation.',
        },
        query: { type: 'string', description: 'Pattern.' },
        // Три флага строкой: каждый булев флаг стоил каркаса схемы (≈9 ток),
        // а все вместе — 28 токенов в каждом запросе.
        flags: {
          type: 'string',
          description: 'Any of: r regex, c case-sensitive, n names only (default: substring).',
        },
        glob: { type: 'string', description: 'Mask.' },
        path: {
          type: 'string',
          description: 'Scope; glob from here.',
        },
        context: {
          type: 'number',
          description: 'Lines around (0-5).',
        },
        limit: { type: 'number', description: 'Cap on hits.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'history',
    side: 'main',
    description: 'Past chats and runs of this project: what was asked before.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['sessions', 'trace'],
          description:
            'sessions: past chats by words, with their uid; trace: one past run by uid — steps, commands, results.',
        },
        query: { type: 'string', description: 'sessions: words to look for.' },
        uid: { type: 'string', description: 'trace: chat uid from sessions.' },
        limit: { type: 'number', description: 'sessions: how many chats.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'read_image',
    side: 'main',
    description:
      'View an image: screenshot, mockup, diagram. It reaches the model as an image in the next message; large files are downscaled. SVG is text — use read.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'PNG, JPEG, WebP, GIF.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'lsp',
    side: 'main',
    description: 'LSP over a language server. The symbol may be words, or path + line of a usage.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['references', 'definition', 'outline', 'rename'],
          description:
            'references: usages in the project (no comments, no same-named vars); definition: ' +
            'where declared; outline: file skeleton, declarations with line and nesting, no bodies; ' +
            'rename: writes declaration and references, other files included.',
        },
        symbol: { type: 'string', description: 'Symbol name.' },
        newName: { type: 'string', description: 'rename: new name.' },
        path: {
          type: 'string',
          description: 'references: narrow to a file. definition: the usage. outline: that file.',
        },
        line: { type: 'number', description: 'definition: usage line, 1-based.' },
        column: { type: 'number', description: 'definition: column, 1-based.' },
        includeDeclaration: {
          type: 'boolean',
          description: 'references: include the declaration (default yes).',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'checks',
    side: 'renderer',
    description: 'Project checks, no writes. Both take path to narrow to one file or folder.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['diagnostics', 'lint'],
          description:
            'diagnostics: errors and warnings the editor knows (call before fixing code); ' +
            'lint: the project linter (ruff, eslint, biome) — findings by file, line, rule.',
        },
        path: {
          type: 'string',
          description: 'One file or folder (diagnostics: open files; lint: whole project).',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'run_tests',
    side: 'main',
    description:
      'Run project tests: the IDE picks the runner (pytest, vitest, jest, node --test). Non-zero exit ' +
      'code means failing tests. target narrows to a file or a test name.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Test file or test name; default all. After an edit, just its test.',
        },
      },
    },
  },
  {
    name: 'project_map',
    side: 'main',
    description:
      'Project map by file names: what the project is, its parts, where tests and entry points ' +
      'are. A short version is in the system prompt: call for details or when it is stale.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mcp',
    side: 'main',
    description:
      'MCP server documents. Fill an address template with values first; binary content is ' +
      'marked, long content is cut.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'read'],
          description: 'list: catalog from settings; read: one document.',
        },
        uri: { type: 'string', description: 'read: address from the catalog.' },
        server: { type: 'string', description: 'list: this server. read: when several share the uri.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'edit',
    side: 'renderer',
    // `action` снято со схемы вместе с дублями `create`/`move`/`delete`: те же
    // операции есть у `file` и меняют диск одинаково. Старые вызовы с `action`
    // живы — схема их больше не объявляет, а `editAction` делегирует в `file`.
    // Одна форма вместо двух: файл и замена в одном элементе `edits[]`. Плоская
    // запись (`path`+`oldText`+`newText`, `path`+`contents`) остаётся живой — её
    // собирает разбор (`flatWrite`), но схема её больше не объявляет: две
    // параллельные формы стоили 96 токенов в каждом запросе.
    description:
      'Change files: edits[] — [{path, oldText, newText}] or [{path, contents}]; ' + 'create, move, delete — file.',
    inputSchema: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          description: 'Files and their changes.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              oldText: { type: 'string', description: 'Anchor: exact, unique.' },
              newText: { type: 'string', description: 'Replacement; empty deletes.' },
              contents: { type: 'string', description: 'Whole file: replaces it.' },
            },
            // `path` здесь НЕ обязателен: проверка схемы срабатывает раньше разбора
            // и выдавала бы «не хватает edits[0].path» вместо точного совета, а разбор
            // понимает ещё две раскладки (поле `edits[].edits[]` и одиночный объект).
            required: [],
          },
        },
      },
      required: [],
    },
  },
  {
    name: 'web',
    side: 'main',
    description: 'The internet over http/https; files are not read.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'fetch'],
          description:
            'search: links, titles, short snippets — the list only, links are not opened, so ' +
            'verify facts instead of stating them; fetch: a page by url — title, plain text, links on it.',
        },
        query: { type: 'string', description: 'search: query.' },
        limit: { type: 'number', description: 'search: how many.' },
        url: { type: 'string', description: 'fetch: page address.' },
        maxChars: { type: 'number', description: 'fetch: text characters (8 000; max 60 000).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'terminal',
    side: 'main',
    description: 'A real pty the user sees. One command per call.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          // Сессия и команда — два разных дела в одном имени: `enum` называет
          // действия, но не говорит, к какому из них относится `id`. Перечень
          // действий не повторяем — он в `enum` рядом.
          description: 'start/write/stop: sessions; run/output/cancel: jobs.',
          enum: ['list', 'start', 'read', 'write', 'stop', 'run', 'output', 'cancel'],
        },
        id: { type: 'string', description: 'read/write/stop: session id. output/cancel: job id.' },
        command: { type: 'string', description: 'start: typed once open. run: the command.' },
        cwd: { type: 'string', description: 'start, run: folder inside the project.' },
        data: { type: 'string', description: 'write: what to type; newline = Enter.' },
        from: { type: 'number', description: 'read, output: offset.' },
        timeout: { type: 'number', description: 'run: seconds (120; background 1800).' },
        background: { type: 'boolean', description: 'run: do not wait, returns a job id.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'file',
    side: 'main',
    description: 'Files and folders inside the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'move', 'delete', 'replace'],
          description:
            'create: whole new file (contents; existing = error); ' +
            'move: from, to; delete: to trash, no undo; ' +
            'replace: all matches, dry-run first.',
        },
        path: { type: 'string', description: 'Path.' },
        // Различие «новый файл целиком» и «правка старого» — главная путаница `file`:
        // модель несла `contents` на `replace` и наоборот. `file` только создаёт файл
        // целиком; менять существующий — это `edit` (якорь или позиции).
        contents: { type: 'string', description: 'create: the whole new file. To change an existing file use edit.' },
        from: { type: 'string', description: 'move: source.' },
        to: { type: 'string', description: 'move: target.' },
        query: { type: 'string', description: 'replace: string or regex.' },
        replacement: { type: 'string', description: 'replace: empty deletes (not "contents").' },
        isRegex: { type: 'boolean', description: 'replace: regex; $1 works.' },
        caseSensitive: { type: 'boolean', description: 'replace: default off.' },
        glob: { type: 'string', description: 'replace: file mask.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'mind',
    side: 'main',
    description: 'Conversation and the human: notes, question, plan, goal, plan approval. The project is not touched.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['remember', 'forget', 'ask', 'steps', 'goal', 'exit_plan'],
          description:
            'remember|forget: notes (text, query, scope); ask: question, the run pauses (question, options); ' +
            'steps: the plan, at the start and after each step (steps); ' +
            'goal: survives the turn (goal, done); exit_plan: hand the plan over for approval (plan).',
        },
        text: { type: 'string', description: 'remember: one thought.' },
        query: { type: 'string', description: 'forget: substring of the note.' },
        scope: { type: 'string', enum: ['workspace', 'global'], description: 'remember, forget.' },
        question: { type: 'string', description: 'ask: one question, no preamble.' },
        options: {
          type: 'array',
          description: 'ask: answers as buttons, 5 max.',
          items: { type: 'string' },
        },
        steps: {
          type: 'array',
          description: 'steps: what to do.',
          // Поля элемента называем явно: модель присылала шаги без `status` и
          // получала отказ уже после вызова — а это целый шаг прогона.
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              // `enum` вместо пересказа значений в описании: их видит и проверка
              // вызова (`wrongArguments`), а не только модель.
              status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
            },
            required: ['text', 'status'],
          },
        },
        goal: { type: 'string', description: 'goal: one phrase; empty keeps it.' },
        done: { type: 'boolean', description: 'goal: true closes it.' },
        plan: { type: 'string', description: 'exit_plan: in brief; empty — the checklist.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'task',
    side: 'main',
    description:
      'A subtask in its own context: it explores the project and returns a short report; ' +
      'your conversation does not grow from its reads. Parallel: use tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Short subtask name, shown on the card.' },
        prompt: {
          type: 'string',
          description: 'What to investigate; the more concrete, the better.',
        },
        tasks: {
          type: 'array',
          description: 'Up to 4 independent subtasks. Not with prompt.',
          // Форма элемента — в полях, а не в тексте описания: подзадача,
          // присланная как `{ name, prompt }`, теряется молча. Обязателен только
          // `prompt`: `description` подставляет сам разбор (parseSubagentTasks).
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              prompt: { type: 'string' },
            },
            required: ['prompt'],
          },
        },
      },
    },
  },
  {
    name: 'browser',
    side: 'main',
    description: 'Own Chromium over CDP; http/https only, needs the Browser setting.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'snapshot', 'click', 'type', 'evaluate', 'zoom', 'close'],
          description:
            'open: a page; snapshot: the page in text — after each action, since the page changes ' +
            'and old refs expire; click, type: by ref; evaluate: a JS expression; zoom; close.',
        },
        url: { type: 'string', description: 'open: page address; no scheme means https.' },
        ref: { type: 'string', description: 'click, type: element number from snapshot.' },
        text: { type: 'string', description: 'type: what to type.' },
        submit: { type: 'boolean', description: 'type: press Enter.' },
        expression: { type: 'string', description: 'evaluate: JS expression; return the value.' },
        mode: { type: 'string', description: 'zoom: in | out | fit | actual (1:1).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'show',
    side: 'main',
    description: 'Show where to look.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'present'],
          description: 'open: a file in the editor at a line; present: result files as buttons.',
        },
        path: { type: 'string', description: 'Path.' },
        line: { type: 'number', description: 'open: line, 1-based.' },
        column: { type: 'number', description: 'open: column, 1-based.' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'present: result files, 1–5, inside the project.',
        },
        note: { type: 'string', description: 'present: one line about the result.' },
      },
      required: ['action'],
    },
  },
];

/** Описание инструмента в том виде, в каком его ждёт OpenAI-совместимый API. */
export interface OpenAiFunctionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
    /** Строгая схема: аргументы обязаны совпасть с ней поле в поле. */
    strict?: boolean;
  };
}

/**
 * Описания инструментов в формате OpenAI.
 *
 * `strict` просит провайдера не отступать от JSON-схемы аргументов. Это не
 * бесплатное улучшение: часть схем со `strict` несовместима (`minLength`,
 * `maxLength` у DeepSeek), а у DeepSeek такие запросы живут только на `/beta`.
 * Поэтому включается вручную на подключении, а не по умолчанию.
 */
export function toOpenAiTools(
  specs: readonly ExposedToolSpec[],
  options: { strict?: boolean } = {},
): OpenAiFunctionTool[] {
  return specs.map((spec) => ({
    type: 'function',
    function: {
      name: spec.name,
      description: spec.description,
      parameters: options.strict
        ? (stripStrictUnsupported(spec.inputSchema) as JsonSchema)
        : (spec.inputSchema as JsonSchema),
      ...(options.strict ? { strict: true } : {}),
    },
  }));
}

/**
 * Ключи JSON-схемы, которых не знает строгий режим DeepSeek.
 *
 * Их перечисляет документация: `minLength`/`maxLength` у строк, `minItems`/
 * `maxItems` у массивов. Своих инструментов это не касается, но схемы MCP
 * приходят от чужих серверов и такие ограничения ставят охотно — с ними весь
 * запрос получил бы 400 вместо ответа.
 */
const STRICT_UNSUPPORTED = ['minLength', 'maxLength', 'minItems', 'maxItems'] as const;

/** Копия схемы без неподдерживаемых ограничений; исходная не меняется. */
function stripStrictUnsupported(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripStrictUnsupported);
  if (typeof schema !== 'object' || schema === null) return schema;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if ((STRICT_UNSUPPORTED as readonly string[]).includes(key)) continue;
    result[key] = stripStrictUnsupported(value);
  }
  return result;
}

/** Разбор аргументов вызова. Битый JSON не роняет цикл — агент получает ошибку текстом. */
export function parseToolArguments(
  raw: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const text = raw.trim();
  if (!text) return { ok: true, value: {} };
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, message: 'Аргументы инструмента должны быть JSON-объектом' };
    }
    // Плоская запись правки — своя же форма в один элемент: `edit(path, oldText,
    // newText)` и `edit(path, contents)`. Схема возит только `edits[]`, а этот
    // разбор принимает обе — иначе короткий вызов превращался бы в «не хватает
    // аргумента: edits» и стоил шага.
    return { ok: true, value: flatWrite(value as Record<string, unknown>) };
  } catch (error) {
    return {
      ok: false,
      message: `Не удалось разобрать аргументы: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Поля плоской записи: что модель написала рядом с `path`, а не внутри `edits[]`. */
const FLAT_WRITE_FIELDS = ['oldText', 'newText', 'contents', 'content'] as const;

/**
 * Плоская запись → `edits[]`. Остальное не трогаем.
 *
 * Схема `edit` описывает одну форму (`edits[]`) — две параллельные формы стоили
 * 96 токенов в каждом запросе. Приём остаётся: файловое действие без `action`
 * даёт запись целиком, а тела правки рядом с `path` — один элемент списка.
 */
function flatWrite(args: Record<string, unknown>): Record<string, unknown> {
  const path = typeof args.path === 'string' ? args.path.trim() : '';
  if (!path) return args;
  if (args.edits !== undefined) return args;
  const write = args.action === undefined || args.action === 'write';
  if (!write) return args;
  const hasBody = FLAT_WRITE_FIELDS.some((field) => typeof args[field] === 'string');
  if (!hasBody) return args;
  const element: Record<string, unknown> = { path };
  for (const field of FLAT_WRITE_FIELDS) {
    if (args[field] !== undefined) element[field] = args[field];
  }
  const rest: Record<string, unknown> = { ...args, edits: [element] };
  for (const field of [...FLAT_WRITE_FIELDS, 'path']) delete rest[field];
  return rest;
}
