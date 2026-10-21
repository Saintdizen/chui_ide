/**
 * Символы проекта для подсказок: карта + языковые серверы.
 *
 * Правило здесь одно, но его легко потерять: если карта символов не собрана
 * (`phase === 'idle'`), расширять нечем — и ответ должен быть пустым, а не «в проекте
 * ничего нет». Пустой список от сервера читается человеком как другая мысль.
 *
 * Второе правило — признак чужого объявления. `package` из ответа сервера и есть
 * «это из зависимости»: по нему подсказка рисует пометку библиотеки.
 */

/** Символ в том виде, в каком его ждут подсказки. */
export interface ProjectSymbol {
  name: string;
  kind: string;
  package: string | null;
}

export interface RawSymbol {
  name: string;
  kind: string;
  package?: string | null;
}

export interface SymbolIndexStatus {
  phase: string;
}

/**
 * Переложить ответ сервера в символы подсказок. `package: undefined` и `null` —
 * одно и то же («своё объявление»): так приходит и карта, и сервер.
 */
export function toProjectSymbols(raw: readonly RawSymbol[]): ProjectSymbol[] {
  return raw.map((symbol) => ({ name: symbol.name, kind: symbol.kind, package: symbol.package ?? null }));
}

/**
 * Можно ли дополнять подсказки ответом сервера.
 *
 * Статуса нет вовсе (`null` — опрос не удался) считаем разрешением: лучше показать,
 * что пришло, чем спрятать ответ из-за неудавшегося запроса состояния.
 */
export function mayExtendFromServers(status: SymbolIndexStatus | null): boolean {
  return status === null || status.phase !== 'idle';
}

/** Собрать ответ «символы проекта» из того, что вернули карта и серверы. */
export function projectSymbolAnswer(found: readonly RawSymbol[], status: SymbolIndexStatus | null): ProjectSymbol[] {
  return mayExtendFromServers(status) ? toProjectSymbols(found) : [];
}
