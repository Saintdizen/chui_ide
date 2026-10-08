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
  | 'search'
  | 'get_diagnostics'
  | 'apply_edit'
  | 'run_terminal';

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
    description: 'Прочитать файл целиком. Для больших файлов сначала читай только нужный диапазон строк.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Абсолютный путь к файлу.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search',
    side: 'main',
    description: 'Поиск подстроки или регулярного выражения по файлам рабочей директории.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Образец поиска.' },
        isRegex: { type: 'boolean', description: 'Считать query регулярным выражением.' },
        glob: { type: 'string', description: 'Маска файлов, например **/*.ts' },
      },
      required: ['query'],
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
export function parseToolArguments(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const text = raw.trim();
  if (!text) return { ok: true, value: {} };
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, message: 'Аргументы инструмента должны быть JSON-объектом' };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch (error) {
    return { ok: false, message: `Не удалось разобрать аргументы: ${error instanceof Error ? error.message : String(error)}` };
  }
}
