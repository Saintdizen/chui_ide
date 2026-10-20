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
  | 'read_skill'
  | 'read_image'
  | 'lsp'
  | 'rename_symbol'
  | 'rename_symbol'
  | 'project_map'
  | 'checks'
  | 'run_tests'
  | 'mcp'
  | 'edit'
  | 'terminal'
  | 'web'
  | 'file'
  | 'plan'
  | 'exit_plan_mode'
  | 'ask'
  | 'task'
  | 'agents'
  | 'browser'
  | 'mind'
  | 'git_read'
  | 'git_write'
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
        path: { type: 'string', description: 'Path.' },
        glob: {
          type: 'string',
          description: 'Path mask: ** any depth, * one segment. Without it, all files.',
        },
        limit: { type: 'number', description: 'glob: how many (default 100, max 2000).' },
      },
    },
  },
  {
    name: 'read',
    side: 'main',
    description:
      'Read a file — whole, a line range (`startLine`/`endLine`) or several at once (`paths`). ' +
      'Output lines are numbered from 1: those numbers go to edit.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'One file.' },
        paths: {
          type: 'array',
          description: 'Instead of path: 2-5 files, output capped.',
          items: { type: 'string' },
        },
        startLine: {
          type: 'number',
          description: 'First line (1-based); default start.',
        },
        endLine: {
          type: 'number',
          description: 'Last line (inclusive); default end.',
        },
        force: {
          type: 'boolean',
          description: 'Re-read what was read this turn.',
        },
      },
    },
  },
  {
    name: 'search',
    side: 'main',
    description:
      'Four sources by action. text (default): project files — path, line, matched text (filesOnly names only). code: symbol declarations. docs: documentation sections. sessions: past conversations.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['text', 'code', 'docs', 'sessions'],
          description:
            'text (default): project files. code: where a symbol is declared. docs: project documentation. sessions: past conversations.',
        },
        query: { type: 'string', description: 'Pattern.' },
        isRegex: { type: 'boolean', description: 'Treat query as a regex (off: plain substring).' },
        caseSensitive: { type: 'boolean', description: 'Case sensitive (off by default).' },
        filesOnly: { type: 'boolean', description: 'Names only, no matching lines.' },
        glob: { type: 'string', description: 'Mask, e.g. **/*.ts' },
        path: {
          type: 'string',
          description: 'Scope; glob counts from here.',
        },
        context: {
          type: 'number',
          description: 'Lines around a match (0-5).',
        },
        limit: { type: 'number', description: 'Default 50; with context 35; files 80.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_skill',
    side: 'main',
    description:
      'Full text of a project skill: the skill list shows only one description line. Call ' +
      'it when the task matches that line, and not twice.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name from the list, for example `release`.' },
      },
      required: ['name'],
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
        path: { type: 'string', description: 'Path (PNG, JPEG, WebP, GIF).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'lsp',
    side: 'main',
    description:
      'Language server lookups: action references — where the symbol is used across the project ' +
      '(no comments, no same-named variables); definition — where it is declared; outline — file ' +
      'skeleton: declarations with line numbers and nesting, no bodies (the numbers work in read ' +
      'ranges). For the first two the name may be written in words, or give path + line of a usage. ' +
      'Requires a language server.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['references', 'definition', 'outline'],
          description: 'What to look up.',
        },
        symbol: { type: 'string', description: 'Symbol name, for example `saveCalibration`.' },
        path: {
          type: 'string',
          description: 'references: narrow to this file. definition: file with the usage. outline: the file.',
        },
        line: { type: 'number', description: 'definition: usage line in that file (1-based).' },
        column: { type: 'number', description: 'definition: column (1-based). Defaults to the start of the line.' },
        includeDeclaration: {
          type: 'boolean',
          description: 'references: include the declaration itself (yes by default).',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'rename_symbol',
    side: 'main',
    description:
      'Rename a symbol semantically: the server changes this symbol only, at the ' +
      'declaration and in all references, other files included. Unlike file (action replace) it ' +
      'does not replace text blindly.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Current symbol name.' },
        newName: { type: 'string', description: 'New name.' },
        path: {
          type: 'string',
          description: 'Narrow to this file; when a name is declared twice.',
        },
      },
      required: ['symbol', 'newName'],
    },
  },
  {
    name: 'checks',
    side: 'renderer',
    description:
      'Project checks, no writes. action diagnostics — errors and warnings the editor knows (call ' +
      'before fixing code, not after); action lint — run the project linter: ruff for Python, eslint ' +
      'or biome for Node, findings by file, line, rule. Both take path to narrow to one file or folder.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['diagnostics', 'lint'],
          description: 'diagnostics: what the editor knows. lint: run the linter.',
        },
        path: {
          type: 'string',
          description: 'One file or folder (diagnostics: default all open files; lint: default whole project).',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'run_tests',
    side: 'main',
    description:
      'Run project tests: the IDE picks the runner (pytest, vitest, jest, node --test). A non-zero exit code means failing tests. target narrows to a file or a test name.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Test file or test name; without it, the whole suite. After a local edit, just its test.',
        },
      },
    },
  },
  {
    name: 'project_map',
    side: 'main',
    description:
      'Project map by file names: what the project is, its parts, where tests and entry ' +
      'points are. A short version is already in the system prompt: call this for details ' +
      'or when it is stale.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mcp',
    side: 'main',
    description:
      'MCP server documents, not actions: action list — the catalog (uri, name, type) of the servers ' +
      'from settings; action read — one document at a uri. List first and take the address there; ' +
      'fill an address template with values first, binary content is marked, long content is cut.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read'], description: 'list: the catalog. read: one document.' },
        uri: { type: 'string', description: 'read: resource address from the catalog.' },
        server: { type: 'string', description: 'list: this server only. read: when several declare the uri.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'edit',
    side: 'renderer',
    description:
      'Change files: checked against the file, then shown for review with undo. Give oldText — ' +
      'an exact fragment unique in the file — and newText; or all four 1-based LSP positions.',
    inputSchema: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Path.' },
              expectedVersion: {
                type: 'number',
                description: 'Version the agent saw; a mismatch rejects position edits.',
              },
              edits: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    newText: { type: 'string', description: 'Replacement; empty removes.' },
                    oldText: { type: 'string', description: 'Anchor: exact text, unique in the file.' },
                    startLine: { type: 'number', description: 'Start line (1-based).' },
                    startColumn: { type: 'number', description: 'Start column (1-based).' },
                    endLine: { type: 'number', description: 'End line (inclusive).' },
                    endColumn: { type: 'number', description: 'End column (exclusive).' },
                  },
                  required: ['newText'],
                },
              },
            },
            required: ['path', 'edits'],
          },
        },
      },
      required: ['edits'],
    },
  },
  {
    name: 'web',
    side: 'main',
    description:
      'The internet: action search — links, titles and short snippets (the list only, links are not ' +
      'opened, so verify facts instead of stating them as true); action fetch — a page by url: title, ' +
      'plain text and the links on it, http and https only, files are not read.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'fetch'], description: 'search: the list. fetch: one page.' },
        query: { type: 'string', description: 'search: search query.' },
        limit: { type: 'number', description: 'search: how many (default 10).' },
        url: { type: 'string', description: 'fetch: full page address: https://example.com/page' },
        maxChars: { type: 'number', description: 'fetch: text characters (default 8 000, max 60 000).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'terminal',
    side: 'main',
    description:
      'Sessions: a real pty the user sees. run executes in the project (background: true returns a job id), output reads a job or lists them, cancel stops one. One command per call.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'start', 'read', 'write', 'stop', 'run', 'output', 'cancel'],
          description: 'Sessions: list, start, read, write, stop. Commands: run, output, cancel.',
        },
        id: { type: 'string', description: 'read, write, stop: session id. output, cancel: job id.' },
        command: { type: 'string', description: 'start: typed once the session opens. run: the command.' },
        cwd: { type: 'string', description: 'start, run: folder inside the project (root by default).' },
        data: { type: 'string', description: 'write: what to type; end with a newline for Enter.' },
        from: { type: 'number', description: 'read, output: offset from the previous read.' },
        timeout: { type: 'number', description: 'run: seconds (default 120, background 1800).' },
        background: { type: 'boolean', description: 'run: do not wait, returns a job id.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'file',
    side: 'main',
    description:
      'Files and folders: create — new file with contents (existing is NOT overwritten, use edit); ' +
      'move — rename or move inside the workspace; delete — to the trash, undo is manual; replace — ' +
      'every occurrence of a string or regex across the project, writes at once.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'move', 'delete', 'replace'], description: 'What to do.' },
        path: { type: 'string', description: 'Path.' },
        contents: { type: 'string', description: 'create: new file contents (required).' },
        from: { type: 'string', description: 'Current path.' },
        to: { type: 'string', description: 'New path.' },
        query: { type: 'string', description: 'replace: what to replace (required).' },
        replacement: { type: 'string', description: 'replace: replacement (empty deletes).' },
        isRegex: { type: 'boolean', description: 'replace: query is a regex; $1 works in the replacement.' },
        caseSensitive: { type: 'boolean', description: 'replace: case sensitive (off by default).' },
        glob: { type: 'string', description: 'replace: file mask, for example **/*.ts' },
      },
      required: ['action'],
    },
  },
  {
    name: 'plan',
    side: 'main',
    description:
      'Work state. steps (default): the plan — call at the start and after each step; goal: survives the turn, done=true closes it, while open the run continues by itself.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['steps', 'goal'],
          description: 'steps: the checklist. goal: the goal.',
        },
        steps: {
          type: 'array',
          description: 'steps: steps.',
          // Поля элемента называем явно: модель присылала шаги без `status` и
          // получала отказ уже после вызова — а это целый шаг прогона.
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'steps: what to do.' },
              // `enum` вместо пересказа значений в описании: их видит и проверка
              // вызова (`wrongArguments`), а не только модель.
              status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
            },
            required: ['text', 'status'],
          },
        },
        goal: {
          type: 'string',
          description: 'goal: one phrase; omitted keeps the current text.',
        },
        done: { type: 'boolean', description: 'goal: true closes it; empty keeps it open.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'exit_plan_mode',
    side: 'main',
    description:
      'Hand the plan to the user for approval. Approval switches to Agent mode, rejection ' +
      'comes back as a comment. Call it when the plan is ready: after update_plan, not ' +
      'instead of it.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: {
          type: 'string',
          description: 'Plan in brief; empty shows the checklist only.',
        },
      },
    },
  },
  {
    name: 'ask',
    side: 'renderer',
    description:
      'Ask the user and wait: the run pauses. Finite choices go into options — the user answers with a click.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'One concrete question, no preamble.' },
        options: {
          type: 'array',
          description: 'Ready answers as buttons, up to 5.',
          items: { type: 'string' },
        },
      },
      required: ['question'],
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
    name: 'agents',
    side: 'main',
    description:
      'Agents in the background: `spawn` starts one and returns an id at once, `list` shows who ' +
      'works on what, `wait` gives their reports (a timeout means still working, not an error), ' +
      '`send` reaches a running agent before its next step, `interrupt` stops one. The agent ' +
      'only reads: edits stay with you.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['spawn', 'list', 'wait', 'send', 'interrupt'],
          description: 'What to do with agents.',
        },
        prompt: { type: 'string', description: 'spawn: the task — this is all the agent sees.' },
        description: { type: 'string', description: 'spawn: short name for the agents panel.' },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'wait: agent ids (up to five); empty means all.',
        },
        id: { type: 'string', description: 'wait for one, send, interrupt: agent id.' },
        text: { type: 'string', description: 'send: what to clarify or correct; short.' },
        timeout: { type: 'number', description: 'wait: seconds (default 120, max 300).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser',
    side: 'main',
    description:
      'Own Chromium over CDP; http or https only, needs the Browser setting. action: open (url), ' +
      'snapshot, click (ref), type (ref, text, submit), evaluate (expression), zoom (mode), ' +
      'close. Take a snapshot after each action: the page changes and old refs expire.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'snapshot', 'click', 'type', 'evaluate', 'zoom', 'close'],
          description: 'Action.',
        },
        url: { type: 'string', description: 'open: page address; no scheme means https.' },
        ref: { type: 'string', description: 'click, type: element number from snapshot.' },
        text: { type: 'string', description: 'type: what to type.' },
        submit: { type: 'boolean', description: 'type: press Enter to submit the form.' },
        expression: { type: 'string', description: 'evaluate: JS expression; return the value.' },
        mode: { type: 'string', description: 'zoom: in | out | fit | actual (1:1).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'mind',
    side: 'main',
    description:
      'Memory: notes that survive the conversation and are shown at the start of every answer. action ' +
      'remember saves one (text); forget removes notes containing a substring (query). Only long-term ' +
      'agreements; scope: workspace (default) or global.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['remember', 'forget'],
          description: 'remember: save a note. forget: drop stale notes or free up space.',
        },
        text: { type: 'string', description: 'remember: short note, one thought, a couple of lines at most.' },
        query: { type: 'string', description: 'forget: substring that identifies notes to remove.' },
        scope: { type: 'string', enum: ['workspace', 'global'], description: 'Workspace unless global.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'git_read',
    side: 'main',
    description:
      'Read the repository: action status (branch, ahead/behind, changed files), diff (worktree ' +
      'against the index, staged=true the index against HEAD), log (recent commits), blame (who ' +
      'changed the lines of a file and when). Read-only. Check status and diff before committing ' +
      'or reverting, so the commit holds exactly what you mean.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'diff', 'log', 'blame'], description: 'What to read.' },
        path: { type: 'string', description: 'diff, log, blame: one file.' },
        staged: { type: 'boolean', description: 'diff: index against HEAD.' },
        limit: { type: 'number', description: 'log: how many (default 20, max 100).' },
        startLine: { type: 'number', description: 'blame: first line (1-based).' },
        endLine: { type: 'number', description: 'blame: last line (inclusive).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'git_write',
    side: 'main',
    description:
      'Change the repository: stage, unstage, commit, checkout, discard, fetch, pull, push. ' +
      'Checkout rewrites files and git may refuse uncommitted changes. Discard is irreversible: ' +
      'ask the user first. Conflicts are resolved by hand, not by repeating pull.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description:
            'stage (git add), unstage (worktree stays), commit, checkout, discard, fetch, ' +
            'pull, push (upstream on the first push; force only on request).',
          enum: ['stage', 'unstage', 'commit', 'checkout', 'discard', 'fetch', 'pull', 'push'],
        },
        paths: {
          type: 'array',
          description: 'stage, unstage, discard, commit: files or folders.',
          items: { type: 'string' },
        },
        message: { type: 'string', description: 'commit: message.' },
        name: { type: 'string', description: 'checkout: branch name.' },
        create: { type: 'boolean', description: 'checkout: create the branch and switch to it.' },
        setUpstream: { type: 'boolean', description: 'push: set upstream to origin (-u).' },
        force: { type: 'boolean', description: 'push: --force-with-lease.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'show',
    side: 'main',
    description:
      'Show the user where to look: action open — a file in the editor at a line, for referring to ' +
      'specific code; action present — result files as buttons in the feed, instead of a path in prose.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'present'],
          description: 'open: jump to code. present: offer results.',
        },
        path: { type: 'string', description: 'Path.' },
        line: { type: 'number', description: 'open: line (1-based).' },
        column: { type: 'number', description: 'open: column (1-based).' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Result files, one to five, inside the project.',
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
    return { ok: true, value: value as Record<string, unknown> };
  } catch (error) {
    return {
      ok: false,
      message: `Не удалось разобрать аргументы: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
