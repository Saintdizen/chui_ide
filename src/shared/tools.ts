/**
 * Описание инструментов агента: какие действия ассистент может вызывать и где
 * они исполняются.
 *
 * `side` — принципиальный момент архитектуры: файловые операции живут в main
 * (там есть доступ к ФС), а правки документов — в renderer (там документная
 * модель и undo). Мост между ними уже готов — это RPC + события.
 *
 * Реализованы все: list_dir, read_file, search и run_terminal — в main,
 * apply_edit — в renderer через хостовый вызов. Какие из них предложить модели,
 * решает сборка: см. `canRun` в `src/main/ai/service.ts`.
 */

export type AgentToolSide = 'main' | 'renderer';

export type AgentToolName =
  | 'list_dir'
  | 'read_file'
  | 'read_files'
  | 'search'
  | 'find_files'
  | 'get_diagnostics'
  | 'apply_edit'
  | 'replace_in_files'
  | 'run_terminal'
  | 'create_file'
  | 'delete_file'
  | 'move_file'
  | 'update_plan'
  | 'git_status'
  | 'git_diff'
  | 'git_log'
  | 'open_file'
  | 'terminal_list'
  | 'terminal_start'
  | 'terminal_read'
  | 'terminal_write'
  | 'terminal_stop';

export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  items?: JsonSchemaProperty;
  enum?: string[];
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface AgentToolSpec {
  name: AgentToolName;
  side: AgentToolSide;
  description: string;
  inputSchema: JsonSchema;
}

export const AGENT_TOOLS: readonly AgentToolSpec[] = [
  {
    name: 'list_dir',
    side: 'main',
    description: 'Показать содержимое папки внутри рабочей директории.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Абсолютный путь к папке.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    side: 'main',
    description:
      'Прочитать файл. Большие файлы читай диапазоном строк — так в контекст попадёт нужное, ' +
      'а не первые 20 000 символов. Строки в выводе нумеруются с 1: по этим номерам удобно ' +
      'готовить правки apply_edit.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Абсолютный путь к файлу.' },
        startLine: {
          type: 'number',
          description: 'Первая строка диапазона (1-based, включительно). Без него — с начала файла.',
        },
        endLine: {
          type: 'number',
          description: 'Последняя строка диапазона (включительно). Без него — до конца (с лимитом строк).',
        },
        force: {
          type: 'boolean',
          description:
            'Перечитать даже ранее прочитанное в этом ходе — на случай, если содержимое выпало из контекста.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'search',
    side: 'main',
    description:
      'Поиск подстроки или регулярного выражения по содержимому файлов рабочей директории. ' +
      'Для обзора «где это вообще встречается» ставь filesOnly=true — вернутся только имена файлов.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Образец поиска.' },
        isRegex: { type: 'boolean', description: 'Считать query регулярным выражением.' },
        caseSensitive: { type: 'boolean', description: 'Учитывать регистр (по умолчанию — нет).' },
        filesOnly: { type: 'boolean', description: 'Вернуть только пути файлов с совпадением, без строк.' },
        glob: { type: 'string', description: 'Маска файлов, например **/*.ts' },
      },
      required: ['query'],
    },
  },
  {
    name: 'find_files',
    side: 'main',
    description:
      'Найти файлы по glob-маске пути — например **/*.test.ts или src/**/*.py. ' +
      'Служебные папки (node_modules, .git, dist и прочие) пропускаются. ' +
      'Вызывай, когда нужно узнать, какие файлы вообще есть в проекте, а не их содержимое.',
    inputSchema: {
      type: 'object',
      properties: {
        glob: {
          type: 'string',
          description:
            'Маска пути: `**` — любая глубина, `*` — в пределах сегмента. ' +
            'Например **/*.py или src/renderer/**. Без маски вернутся все файлы проекта.',
        },
        limit: { type: 'number', description: 'Максимум путей (по умолчанию 200, максимум 2000).' },
      },
    },
  },
  {
    name: 'read_files',
    side: 'main',
    description:
      'Прочитать несколько файлов одним вызовом — когда нужно свериться с 2–5 файлами сразу. ' +
      'Экономит шаги: вместо пяти read_file хватает одного. Каждый файл возвращается с номерами ' +
      'строк, как у read_file, но общий размер вывода ограничен.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          description: 'Абсолютные пути файлов.',
          items: { type: 'string', description: 'Путь к файлу.' },
        },
      },
      required: ['paths'],
    },
  },
  {
    name: 'replace_in_files',
    side: 'main',
    description:
      'Заменить все вхождения строки или регулярного выражения по файлам проекта — массовое ' +
      'переименование, а не точечная правка. Для изменения одной пары строк используй apply_edit. ' +
      'Маска glob ограничивает, в каких файлах искать. Все изменения сразу пишутся на диск ' +
      'и видны в панели изменений.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Что заменить.' },
        replacement: { type: 'string', description: 'Чем заменить (пустая строка — удалить).' },
        isRegex: {
          type: 'boolean',
          description: 'Считать query регулярным выражением (тогда в замене работают группы $1).',
        },
        caseSensitive: { type: 'boolean', description: 'Учитывать регистр (по умолчанию — нет).' },
        glob: { type: 'string', description: 'Маска файлов, например **/*.ts' },
      },
      required: ['query', 'replacement'],
    },
  },
  {
    name: 'get_diagnostics',
    side: 'renderer',
    description:
      'Ошибки и предупреждения, которые показывает редактор: без аргументов — по всем ' +
      'открытым файлам. Вызывай перед тем, как чинить код, а не после.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ограничить одним файлом (абсолютный путь).' },
      },
    },
  },
  {
    name: 'apply_edit',
    side: 'renderer',
    description:
      'Применить правки к документам. Путь абсолютный, позиции 1-based (как в LSP). ' +
      'В каждой правке передавай oldText — точный текст, который она заменяет: по нему ' +
      'правка сверяется с файлом и не «попадает» в чужое место. Обязательно для строк ' +
      'с не-ASCII (кириллица, эмодзи), где легко ошибиться в колонках. ' +
      'Правку видит и подтверждает пользователь, она попадает в undo-стек редактора.',
    inputSchema: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          description: 'Массив объектов { path, expectedVersion, edits: TextEdit[] }.',
          items: { type: 'object', description: 'FileEdit' },
        },
      },
      required: ['edits'],
    },
  },
  {
    name: 'run_terminal',
    side: 'main',
    description:
      'Выполнить команду оболочки в рабочей папке и вернуть её вывод. ' +
      'Каждый запуск подтверждает пользователь, поэтому команда должна быть одной и по делу.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Команда для запуска.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'create_file',
    side: 'main',
    description:
      'Создать новый файл с содержимым. Существующий файл НЕ перетирается — вернётся ошибка; ' +
      'для правки существующего файла используй apply_edit.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Абсолютный путь к новому файлу.' },
        contents: { type: 'string', description: 'Содержимое нового файла.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'delete_file',
    side: 'main',
    description: 'Удалить файл или папку (в корзину). Вызывай только когда уверен: отмена — из корзины вручную.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Абсолютный путь к файлу или папке.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'move_file',
    side: 'main',
    description: 'Переместить или переименовать файл либо папку внутри рабочей директории.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Текущий абсолютный путь.' },
        to: { type: 'string', description: 'Новый абсолютный путь.' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'update_plan',
    side: 'main',
    description:
      'Обновить план работы: список шагов со статусами. Вызывай в начале задачи, а затем после ' +
      'каждого выполненного шага — пользователь видит прогресс, а ты не теряешь нить.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'Шаги плана: { text, status }, где status — pending | in_progress | done.',
          items: { type: 'object', description: 'PlanStep' },
        },
      },
      required: ['steps'],
    },
  },
  {
    name: 'git_status',
    side: 'main',
    description:
      'Состояние git: текущая ветка и список изменённых файлов (индекс и рабочее дерево). ' +
      'Смотри перед тем, как коммитить или откатывать.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'git_diff',
    side: 'main',
    description:
      'Diff файла по git: рабочее дерево против индекса, а с staged=true — индекс против HEAD. ' +
      'Контекст — 3 строки вокруг правок, независимо от настроек git.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Абсолютный путь файла.' },
        staged: { type: 'boolean', description: 'true — сравнить индекс с HEAD.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'git_log',
    side: 'main',
    description:
      'История коммитов: последние изменения репозитория или одного файла. Read-only — ' +
      'ничего не меняет. Возвращает hash, дату, автора и заголовок каждого коммита.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Сколько последних коммитов (по умолчанию 20, максимум 100).' },
        path: { type: 'string', description: 'Ограничить историю одним файлом (абсолютный путь).' },
      },
    },
  },
  {
    name: 'open_file',
    side: 'renderer',
    description:
      'Открыть файл в редакторе на нужной строке — чтобы пользователь сразу увидел место, ' +
      'о котором идёт речь. Вызывай, когда ссылаешься на конкретный код.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Абсолютный путь файла.' },
        line: { type: 'number', description: 'Строка (1-based).' },
        column: { type: 'number', description: 'Столбец (1-based).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'terminal_list',
    side: 'main',
    description: 'Список открытых терминальных сессий (id, cwd, pid) — для long-running процессов.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'terminal_start',
    side: 'main',
    description:
      'Открыть НАСТОЯЩИЙ терминал (pty) и вернуть его id. В отличие от run_terminal, сессия ' +
      'живёт между шагами: можно запустить долгий процесс (сервер, watch) и позже читать его вывод. ' +
      'Команду можно не передавать и набирать потом через terminal_write.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Необязательная команда, которую наберём сразу после старта.' },
        cwd: { type: 'string', description: 'Рабочая папка (по умолчанию — корень проекта).' },
      },
    },
  },
  {
    name: 'terminal_read',
    side: 'main',
    description:
      'Прочитать НОВЫЙ вывод сессии. Передай from — смещение, полученное в прошлом ответе; ' +
      'без него прочитаешь весь буфер (до 60 000 символов).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'id сессии из terminal_start или terminal_list.' },
        from: { type: 'number', description: 'С какого смещения читать (из поля offset прошлого чтения).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'terminal_write',
    side: 'main',
    description:
      'Отправить ввод в сессию (как будто пользователь набрал в терминале). Завершай строку \\n, ' +
      'если хочешь нажать Enter.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'id сессии.' },
        data: { type: 'string', description: 'Что написать в терминал.' },
      },
      required: ['id', 'data'],
    },
  },
  {
    name: 'terminal_stop',
    side: 'main',
    description: 'Остановить сессию терминала (kill процесса).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'id сессии.' },
      },
      required: ['id'],
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
  };
}

export function toOpenAiTools(specs: readonly AgentToolSpec[]): OpenAiFunctionTool[] {
  return specs.map((spec) => ({
    type: 'function',
    function: { name: spec.name, description: spec.description, parameters: spec.inputSchema },
  }));
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
