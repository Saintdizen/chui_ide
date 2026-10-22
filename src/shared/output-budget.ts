import { estimateTextTokens } from './context-fit';

/** Ограничения одновременно по памяти и оценке токенов, без зависимости от провайдера. */
export interface OutputLimit {
  chars: number;
  tokens: number;
}

/** Самый длинный префикс/суффикс, укладывающийся в оба ограничения. */
export function fitOutput(text: string, limit: OutputLimit, tail = false): string {
  const chars = Math.max(0, Math.floor(limit.chars));
  const tokens = Math.max(0, Math.floor(limit.tokens));
  if (text.length <= chars && estimateTextTokens(text) <= tokens) return text;
  let low = 0;
  let high = Math.min(text.length, chars);
  const slice = (size: number) => (tail ? text.slice(text.length - size) : text.slice(0, size));
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTextTokens(slice(mid)) <= tokens) low = mid;
    else high = mid - 1;
  }
  // Суррогатную пару не разрываем даже в нетипичном выводе команды.
  if (low > 0 && low < text.length) {
    const edge = tail ? text.charCodeAt(text.length - low) : text.charCodeAt(low - 1);
    if (tail ? edge >= 0xdc00 && edge <= 0xdfff : edge >= 0xd800 && edge <= 0xdbff) low -= 1;
  }
  return slice(low);
}

/** Показанный префикс состоит только из полных строк. Длинная первая строка не считается прочитанной. */
export function fitOutputLines(text: string, limit: OutputLimit): { text: string; lines: number; complete: boolean } {
  const fitted = fitOutput(text, limit);
  if (fitted === text) return { text, lines: text.split('\n').length, complete: true };
  const newline = fitted.lastIndexOf('\n');
  if (newline < 0) return { text: '', lines: 0, complete: false };
  const body = fitted.slice(0, newline);
  return { text: body, lines: body.split('\n').length, complete: false };
}
