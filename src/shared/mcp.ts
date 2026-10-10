/**
 * Внешние инструменты по Model Context Protocol: имена, разбор `tools/list` и
 * разбор результата вызова.
 *
 * MCP-серверы — отдельные процессы, которые объявляют свои инструменты. Наши
 * инструменты перечислены статично (`shared/tools.ts`), а эти приходят снаружи,
 * поэтому имена, описания и схемы нужно привести к одной форме и проверить:
 * сервер — чужая программа, и мусор в её ответе не должен ломать агентский цикл.
 */

/** Префикс имени, по которому видно: инструмент пришёл снаружи, а не наш. */
export const MCP_PREFIX = 'mcp__';

/**
 * Потолок длины имени инструмента. У OpenAI-совместимых API это 64 символа, и
 * запрос с длинным именем отклоняется целиком — то есть теряются все шаги.
 * Берём чуть меньше: у шлюзов встречаются свои ограничения.
 */
const MAX_NAME_CHARS = 60;

/** Один сервер в настройках: команда запуска и аргументы. */
export interface McpServerConfig {
  /** Короткое имя, по нему строится имя инструмента. */
  id: string;
  command: string;
  args: string[];
  /** Дополнительные переменные окружения сервера. */
  env?: Record<string, string>;
  enabled: boolean;
}

/** Инструмент, объявленный MCP-сервером, в нашей форме. */
export interface McpToolInfo {
  serverId: string;
  /** Имя внутри сервера: его ждёт `tools/call`. */
  toolName: string;
  /** Имя, которое видит модель. */
  exposedName: string;
  description: string;
  /** Схема аргументов как есть: у MCP это обычная JSON Schema. */
  inputSchema: object;
  /** Сервер пометил инструмент как «только чтение» — подтверждение не нужно. */
  readOnly: boolean;
}

/** Привести часть имени к допустимым символам: буквы, цифры, `_`, `-`. */
function sanitizePart(value: string): string {
  return value
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[-_]+|[-_]+$/g, '');
}

/**
 * Имя инструмента для модели: `mcp__<сервер>__<инструмент>`. Чистка заменяет
 * двойные подчёркивания одинарным, поэтому разделитель `__` в имени ровно один —
 * имя остаётся разбираемым.
 *
 * Длинное имя обрезаем: лимит API важнее формы. Обрезка безопасна — сервис ищет
 * инструмент по этому имени в своей таблице, а не разбирает его обратно.
 */
export function exposedToolName(serverId: string, toolName: string): string {
  const server = sanitizePart(serverId) || 'server';
  const tool = sanitizePart(toolName) || 'tool';
  return `${MCP_PREFIX}${server}__${tool}`.slice(0, MAX_NAME_CHARS);
}

/** Наш ли это инструмент или внешний: по имени видно, куда его адресовать. */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_PREFIX);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Разобрать ответ `tools/list`. Сервер — чужая программа: инструмент без имени
 * пропускаем, схему по умолчанию считаем пустым объектом (модель тогда вызовет
 * инструмент без аргументов — это лучше, чем отсутствие инструмента).
 */
export function parseMcpTools(serverId: string, payload: unknown): McpToolInfo[] {
  const tools = asRecord(payload)?.tools;
  if (!Array.isArray(tools)) return [];

  const seen = new Set<string>();
  const parsed: McpToolInfo[] = [];
  for (const item of tools) {
    const record = asRecord(item);
    if (!record) continue;
    const toolName = asString(record.name).trim();
    if (!toolName) continue;

    const exposedName = exposedToolName(serverId, toolName);
    // Два разных инструмента могут дать одно имя после чистки: второй пропускаем,
    // иначе модель вызовет не то.
    if (seen.has(exposedName)) continue;
    seen.add(exposedName);

    const annotations = asRecord(record.annotations);
    parsed.push({
      serverId,
      toolName,
      exposedName,
      description: asString(record.description).trim(),
      inputSchema: asRecord(record.inputSchema) ?? { type: 'object', properties: {} },
      readOnly: annotations?.readOnlyHint === true,
    });
  }
  return parsed;
}

/**
 * Ответ `tools/call` → текст для модели. MCP отдаёт содержимое частями разных
 * видов (текст, картинка, ссылка на ресурс); картинку и ресурс показываем
 * пометкой — в контекст модели уходит текст, а не байты.
 */
export function mcpToolResultText(payload: unknown): { text: string; isError: boolean } {
  const result = asRecord(payload);
  const isError = result?.isError === true;
  const content = result?.content;

  if (!Array.isArray(content)) {
    const structured = result?.structuredContent;
    if (structured !== undefined) return { text: JSON.stringify(structured), isError };
    return { text: isError ? 'Инструмент вернул ошибку без описания' : 'Инструмент не вернул содержимого', isError };
  }

  const parts: string[] = [];
  for (const item of content) {
    const record = asRecord(item);
    if (!record) continue;
    switch (record.type) {
      case 'text':
        parts.push(asString(record.text));
        break;
      case 'image':
        parts.push(`[изображение: ${asString(record.mimeType) || 'без типа'}]`);
        break;
      case 'resource':
        parts.push(`[ресурс: ${asString(asRecord(record.resource)?.uri) || 'без адреса'}]`);
        break;
      case 'audio':
        parts.push('[аудио]');
        break;
      default:
        break;
    }
  }

  const text = parts
    .filter((part) => part !== '')
    .join('\n')
    .trim();
  if (!text)
    return { text: isError ? 'Инструмент вернул ошибку без описания' : 'Инструмент не вернул текста', isError };
  return { text, isError };
}

/**
 * Проверка серверов из настроек: файл правят руками, поэтому берём только записи
 * с командой и рабочим именем. Дубли имён отбрасываем — иначе неясно, какой
 * сервер вызывать.
 */
export function normalizeMcpServers(value: unknown): McpServerConfig[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const servers: McpServerConfig[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const id = sanitizePart(asString(record.id).trim());
    const command = asString(record.command).trim();
    if (!id || !command || seen.has(id)) continue;
    seen.add(id);

    const args = Array.isArray(record.args) ? record.args.filter((arg): arg is string => typeof arg === 'string') : [];
    const env: Record<string, string> = {};
    const rawEnv = asRecord(record.env);
    if (rawEnv) {
      for (const [key, value] of Object.entries(rawEnv)) {
        if (typeof value === 'string' && key.trim()) env[key] = value;
      }
    }

    servers.push({
      id,
      command,
      args,
      ...(Object.keys(env).length > 0 ? { env } : {}),
      // Сервер включён по умолчанию: добавили — значит, хотят пользоваться.
      enabled: record.enabled !== false,
    });
  }
  return servers;
}
