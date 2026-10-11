/**
 * Разбор ответов LSP про код-линзы: подписи над объявлениями с действием.
 *
 * Код-линза — короткая подпись у строки кода (например, «3 ссылки» у функции или
 * «Запустить тест» у теста). Подпись приходит с командой, которую исполняет сам
 * сервер: `workspace/executeCommand`. Часть серверов отдаёт линзы без команды —
 * её запрашивают отдельно (`codeLens/resolve`), и тогда нужен исходный объект
 * целиком: в нём сервер держит своё `data`.
 *
 * Модуль чистый: только разбор и формы, без Monaco и процессов.
 */

/** Диапазон в нумерации LSP (строки и столбцы с нуля). */
export interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/** Команда сервера: что показать и что исполнить. */
export interface CodeLensCommand {
  /** Подпись на экране. */
  title: string;
  /** Имя команды сервера (уходит в `workspace/executeCommand`). */
  command: string;
  arguments: readonly unknown[];
}

/** Одна код-линза: место, готовая команда (если есть) и сырой ответ сервера. */
export interface CodeLensEntry {
  range: LspRange;
  /** Готовая команда; `null` — сервер ждёт `codeLens/resolve`. */
  command: CodeLensCommand | null;
  /** Исходный объект ответа: его сервер ждёт в `codeLens/resolve`. */
  source: Record<string, unknown>;
}

function isLspRange(value: unknown): value is LspRange {
  if (!value || typeof value !== 'object') return false;
  const range = value as {
    start?: { line?: unknown; character?: unknown };
    end?: { line?: unknown; character?: unknown };
  };
  return (
    typeof range.start?.line === 'number' &&
    typeof range.start.character === 'number' &&
    typeof range.end?.line === 'number' &&
    typeof range.end.character === 'number'
  );
}

/**
 * Команда из объекта LSP (`command` у код-линзы или у `codeLens/resolve`).
 * Без имени команды или заголовка — `null`: показать такую линзу нечем.
 */
export function commandFromLens(raw: unknown): CodeLensCommand | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = (raw as { command?: unknown }).command;
  if (!value || typeof value !== 'object') return null;
  const command = value as { title?: unknown; command?: unknown; arguments?: unknown };
  if (typeof command.title !== 'string' || typeof command.command !== 'string') return null;
  return {
    title: command.title,
    command: command.command,
    arguments: Array.isArray(command.arguments) ? command.arguments : [],
  };
}

/**
 * Код-линзы из ответа сервера. Записи без диапазона отбрасываем: показать их
 * негде; остальные сохраняем целиком вместе с сырым объектом — он нужен для
 * `codeLens/resolve`.
 */
export function toCodeLenses(result: unknown): CodeLensEntry[] {
  if (!Array.isArray(result)) return [];
  const lenses: CodeLensEntry[] = [];
  for (const item of result) {
    if (!item || typeof item !== 'object') continue;
    const value = item as Record<string, unknown>;
    if (!isLspRange(value.range)) continue;
    lenses.push({
      range: value.range,
      command: commandFromLens(value),
      source: value,
    });
  }
  return lenses;
}
