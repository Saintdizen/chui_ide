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

/**
 * Потолки на внешние инструменты. Описания уходят модели в КАЖДОМ запросе,
 * поэтому сервер с сотней инструментов съел бы окно сам по себе. Числа выбраны
 * так, чтобы хватало на обычную установку (файловый сервер, git, память) и при
 * этом оставался запас: дальше начинается уже «модель путается в выборе».
 */
export const MAX_MCP_TOOLS_PER_SERVER = 24;
export const MAX_MCP_TOOLS = 64;

/**
 * Ресурс MCP-сервера. Это не действие, а документ: сервер объявляет у себя
 * каталог адресов (`uri`), и их читают, а не вызывают. Инструменты MCP отвечают
 * на «сделай», ресурсы — на «покажи, что у тебя есть».
 */
export interface McpResourceInfo {
  serverId: string;
  /** Человеческое имя ресурса: сервер может его и не дать. */
  name: string;
  /** Адрес ресурса: по нему же читают. */
  uri: string;
  description: string;
  mimeType: string;
  /**
   * Это шаблон адреса (`resourceTemplates`), а не готовый ресурс: в нём есть
   * подстановки `{...}`, и читать по нему нельзя — сначала подставь значения.
   */
  template: boolean;
}

/**
 * Потолок каталога ресурсов и одного прочитанного ресурса.
 *
 * Каталог — тоже текст в контексте модели, и сервер вправе объявить сотни
 * записей: схемы ресурсов в запрос не идут, но каталог модель читает целиком.
 * А прочитанный ресурс — это документ, а не весь сервер, поэтому у него свой,
 * более высокий потолок.
 */
export const MAX_MCP_RESOURCES = 200;
export const MAX_MCP_RESOURCE_CHARS = 40_000;

/** Итог отбора: что предложим модели и по сколько инструментов пропущено. */
export interface McpToolSelection {
  offered: McpToolInfo[];
  /** Сколько инструментов пропущено у каждого сервера (для пометки в настройках). */
  skippedByServer: Record<string, number>;
  /** Сколько пропущено всего. */
  skipped: number;
}

/**
 * Отобрать инструменты, которые пойдут модели. Порядок стабильный — по серверу и
 * имени: иначе набор «прыгал» бы между шагами, а с ним и кеш промпта.
 *
 * Обрезка осознанно простая: список сервера — не приоритетный, а произвольный,
 * и угадать, какие из двухсот инструментов нужнее, мы всё равно не можем.
 * Поэтому берём первые по алфавиту, а сколько пропущено — показываем в настройках,
 * чтобы человек знал про потолок, а не считал список полным.
 */
export function selectMcpTools(
  tools: readonly McpToolInfo[],
  limits: { perServer?: number; total?: number } = {},
): McpToolSelection {
  const perServerLimit = Math.max(1, limits.perServer ?? MAX_MCP_TOOLS_PER_SERVER);
  const totalLimit = Math.max(1, limits.total ?? MAX_MCP_TOOLS);

  const ordered = [...tools].sort((a, b) =>
    a.serverId === b.serverId ? a.exposedName.localeCompare(b.exposedName) : a.serverId.localeCompare(b.serverId),
  );

  const offered: McpToolInfo[] = [];
  const taken = new Map<string, number>();
  const skippedByServer: Record<string, number> = {};
  let skipped = 0;

  const skip = (serverId: string): void => {
    skippedByServer[serverId] = (skippedByServer[serverId] ?? 0) + 1;
    skipped += 1;
  };

  for (const tool of ordered) {
    if (offered.length >= totalLimit) {
      skip(tool.serverId);
      continue;
    }
    const seen = taken.get(tool.serverId) ?? 0;
    if (seen >= perServerLimit) {
      skip(tool.serverId);
      continue;
    }
    taken.set(tool.serverId, seen + 1);
    offered.push(tool);
  }

  return { offered, skippedByServer, skipped };
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

/** Одна запись каталога — так сервер отдаёт и список ресурсов, и шаблоны. */
function parseResourceItem(serverId: string, item: unknown, template: boolean): McpResourceInfo | null {
  const record = asRecord(item);
  if (!record) return null;
  const uri = asString(template ? record.uriTemplate : record.uri).trim();
  if (!uri) return null;
  return {
    serverId,
    uri,
    name: asString(record.name).trim() || uri,
    description: asString(record.description).trim(),
    mimeType: asString(record.mimeType).trim(),
    template,
  };
}

/**
 * Разобрать ответ `resources/list`:
 *
 * Ответ сервера — `{ resources: [...] }`. Шаблонов адресов в нём нет: они
 * отдельным методом, их разбирает `parseMcpResourceTemplates`. Одинаковые
 * адреса отбрасываем: один uri — одна запись, иначе каталог двоится.
 */
export function parseMcpResources(serverId: string, payload: unknown): McpResourceInfo[] {
  const items = asRecord(payload)?.resources;
  if (!Array.isArray(items)) return [];

  const seen = new Set<string>();
  const parsed: McpResourceInfo[] = [];
  for (const item of items) {
    const resource = parseResourceItem(serverId, item, false);
    if (!resource || seen.has(resource.uri)) continue;
    seen.add(resource.uri);
    parsed.push(resource);
  }
  return parsed;
}

/** Разобрать `resources/templates/list`: шаблоны адресов, читать их без подстановки нельзя. */
export function parseMcpResourceTemplates(serverId: string, payload: unknown): McpResourceInfo[] {
  const items = asRecord(payload)?.resourceTemplates;
  if (!Array.isArray(items)) return [];

  const seen = new Set<string>();
  const parsed: McpResourceInfo[] = [];
  for (const item of items) {
    const template = parseResourceItem(serverId, item, true);
    if (!template || seen.has(template.uri)) continue;
    seen.add(template.uri);
    parsed.push(template);
  }
  return parsed;
}

/**
 * Каталог ресурсов текстом для модели: сначала готовые адреса, потом шаблоны.
 *
 * Пустой каталог — это не ошибка: сервер вправе не объявлять ресурсов вовсе,
 * и сказать об этом надо словами, чтобы модель не искала «где-то ещё».
 */
export function formatMcpResources(resources: readonly McpResourceInfo[], limit = MAX_MCP_RESOURCES): string {
  if (resources.length === 0) {
    return 'Ни один MCP-сервер не объявил ресурсов: у них есть только инструменты.';
  }

  const shown = resources.slice(0, Math.max(1, limit));
  const lines: string[] = [];
  for (const resource of shown) {
    const kind = resource.template ? 'шаблон' : 'ресурс';
    const mime = resource.mimeType ? ` · ${resource.mimeType}` : '';
    const note = resource.description ? ` — ${resource.description}` : '';
    // Сервер называем всегда: адреса у серверов не пересекаются, а читать
    // ресурс надо у того же, кто его объявил.
    lines.push(`[${resource.serverId}] ${kind} ${resource.uri} · ${resource.name}${mime}${note}`);
  }

  const hidden = resources.length - shown.length;
  if (hidden > 0) lines.push(`… ещё ${hidden}: каталог больше потолка ${shown.length}`);
  return lines.join('\n');
}

/**
 * Ответ `resources/read` → текст для модели.
 *
 * Содержимое приходит частями `contents`: текст — как есть, двоичное — пометкой
 * (байты модели не нужны, а base64 съел бы окно). Длинный текст режется.
 */
export function mcpResourceContentText(
  payload: unknown,
  limit = MAX_MCP_RESOURCE_CHARS,
): { text: string; isError: boolean } {
  const result = asRecord(payload);
  const contents = result?.contents;
  if (!Array.isArray(contents)) {
    return { text: 'Сервер не вернул содержимого ресурса', isError: false };
  }

  const parts: string[] = [];
  for (const item of contents) {
    const record = asRecord(item);
    if (!record) continue;
    const mime = asString(record.mimeType).trim();
    if (typeof record.text === 'string') {
      parts.push(mime ? `[${mime}]\n${record.text}` : record.text);
      continue;
    }
    if (typeof record.blob === 'string') {
      const bytes = Math.floor((record.blob.length * 3) / 4);
      parts.push(`[двоичные данные: ${mime || 'без типа'}, ~${bytes} байт]`);
      continue;
    }
    parts.push(`[пустая часть ресурса: ${asString(record.uri) || 'без адреса'}]`);
  }

  const text = parts.join('\n\n').trim();
  if (!text) return { text: 'Сервер вернул пустой ресурс', isError: false };
  if (text.length <= limit) return { text, isError: false };
  // Обрезка по границе строки: разорванный символ ломает и чтение, и токены.
  const cut = text.slice(0, limit);
  const lineBreak = cut.lastIndexOf('\n');
  const head = (lineBreak > limit / 2 ? cut.slice(0, lineBreak) : cut).trimEnd();
  return { text: `${head}\n\n… ресурс длиннее ${limit} символов, показано начало`, isError: false };
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
