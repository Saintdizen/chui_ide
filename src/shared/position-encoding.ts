/**
 * Кодировка позиций в LSP: в чём считаются колонки на строке.
 *
 * Протокол по умолчанию считает позиции в UTF-16 code units — это то, что даёт
 * `string.length` в JS и что редактор получает «бесплатно». Но некоторые серверы
 * (например, часть rust-analyzer-сборок и серверы, объявившие `utf-32`) ждут
 * номера КОДОВЫХ ТОЧЕК — тогда каждый эмодзи или другой суррогатный символ
 * сдвигает все колонки справа от него, и правка приезжает не туда.
 *
 * Модуль __чистый__: ни DOM, ни RPC. Поэтому правило пересчёта живёт в одном
 * месте и проверяется тестом, а не расходится по десятку мест `character - 1`.
 */

/** В чём сервер считает колонки. */
export type PositionEncoding = 'utf-16' | 'utf-32';

/**
 * Выбрать кодировку по тому, что предложил сервер в ответе на `initialize`.
 *
 * `general.positionEncodings` — список, в порядке предпочтения сервера; наш
 * клиент умеет utf-16 (нативно) и utf-32 (пересчётом). Берём первый общий;
 * нет списка — стандартный utf-16, как требует протокол.
 */
export function negotiateEncoding(offered: string | readonly string[] | undefined): PositionEncoding {
  // Протокол допускает и строку, и массив — приводим к массиву.
  const list = Array.isArray(offered) ? offered : offered === undefined ? [] : [offered];
  // Нативный utf-16 предпочитаем ВСЕГДА, если сервер его допускает: он не требует
  // пересчёта, значит нет и шанса сдвинуть позицию. Иначе берём utf-32.
  if (list.includes('utf-16')) return 'utf-16';
  if (list.includes('utf-32')) return 'utf-32';
  // Предложили только незнакомое (utf-8) — протокол велит откатиться к utf-16.
  return 'utf-16';
}

/**
 * Сколько «единиц» кодировки в строке — длина колонки в представлении сервера.
 *
 * `limit` ограничивает просмотр: считаем только до нужного места, а не всю
 * гигантскую строку на каждый символ.
 */
export function columnLength(line: string, encoding: PositionEncoding): number {
  if (encoding === 'utf-16') return line.length;
  // UTF-32: суррогатная пара (emoji, редкие иероглифы) — ОДИН код, не два.
  let units = 0;
  for (let at = 0; at < line.length; at += 1) {
    units += 1;
    if (isHighSurrogate(line.charCodeAt(at)) && isLowSurrogate(line.charCodeAt(at + 1))) {
      at += 1;
    }
  }
  return units;
}

/**
 * Пересчёт колонки из внутреннего представления (UTF-16, 0-based) в серверное.
 *
 * Вход — 0-based колонка в `line` (как её знает редактор). Выход — `character`
 * для LSP в нужной кодировке. Колонка за концом строки считается по концу.
 */
export function toServerColumn(line: string, column: number, encoding: PositionEncoding): number {
  if (encoding === 'utf-16') return column;
  const end = Math.min(Math.max(column, 0), line.length);
  let units = 0;
  let at = 0;
  while (at < end) {
    // Суррогатная пара занимает в UTF-16 два знака, а в UTF-32 — один код.
    const pair = isHighSurrogate(line.charCodeAt(at)) && isLowSurrogate(line.charCodeAt(at + 1));
    if (pair) {
      // Колонка ВНУТРИ пары (между суррогатами) — не целый код: сервер ждёт
      // границу кода, поэтому округляем вниз и на этом заканчиваем счёт.
      if (at + 2 > end) break;
      units += 1;
      at += 2;
    } else {
      units += 1;
      at += 1;
    }
  }
  return units;
}

/**
 * Обратный пересчёт: `character` от сервера → 0-based колонка редактора.
 *
 * Нужно для ответов (подсказки, правки, диагностика): их позиции надо вернуть
 * в UTF-16. Если сервер прислал колонку за концом строки — упираемся в конец.
 */
export function fromServerColumn(line: string, character: number, encoding: PositionEncoding): number {
  if (encoding === 'utf-16') return Math.min(Math.max(character, 0), line.length);
  const want = Math.max(character, 0);
  let units = 0;
  let seen = 0;
  while (units < line.length && seen < want) {
    const pair = isHighSurrogate(line.charCodeAt(units)) && isLowSurrogate(line.charCodeAt(units + 1));
    units += pair ? 2 : 1;
    seen += 1;
  }
  return units;
}

/** Старший код суррогатной пары UTF-16 (D800–DBFF). */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Младший код суррогатной пары UTF-16 (DC00–DFFF). */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
