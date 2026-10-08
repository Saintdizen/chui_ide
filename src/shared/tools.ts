/**
 * Описание инструментов агента. Пока это только контракт: он фиксирует,
 * какие действия ассистент сможет вызывать и где они исполняются.
 *
 * `side` — принципиальный момент архитектуры: файловые операции живут в main
 * (там есть доступ к ФС), а правки документов — в renderer (там документная
 * модель и undo). Мост между ними уже готов — это RPC + события.
 */

export type AgentToolSide = 'main' | 'renderer';

export type AgentToolName =
  | 'list_dir'
  | 'read_file'
  | 'search'
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
    name: 'apply_edit',
    side: 'renderer',
    description:
      'Применить правки к документам. Позиции — 1-based, как в LSP. Правка попадает в undo-стек редактора.',
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
      'Запустить команду в оболочке рабочей директории. Требует подтверждения пользователя (этап 4, нужен node-pty).',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Команда для запуска.' },
      },
      required: ['command'],
    },
  },
];
