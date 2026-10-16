/**
 * Подсказка «допиши за меня» (inline-автодополнение, как Copilot).
 *
 * Модель получает текст вокруг курсора и просит продолжить код. Здесь —
 * чистая часть этой затеи: нарезка контекста вокруг курсора, сборка промпта и
 * очистка ответа. Запрос к модели и показ подсказки в редакторе живут отдельно
 * (main и renderer), поэтому логику можно проверить тестами без сети и окна.
 */

import { toOffset } from './edits';

/** Сколько символов вокруг курсора отдаём модели. Больше — дороже и без пользы. */
export const DEFAULT_MAX_PREFIX_CHARS = 2000;
export const DEFAULT_MAX_SUFFIX_CHARS = 800;

/** Маркер места вставки в промпте: по нему модель понимает, куда писать. */
export const CURSOR_MARKER = '<CURSOR>';

/** Потолок ответа: подсказка — это одна-две строки, а не целый блок. */
export const INLINE_MAX_TOKENS = 160;
/** Жёсткий предел длины подсказки: защита от модели, которая не послушалась `maxTokens`. */
export const INLINE_MAX_CHARS = 800;

/** Правило для модели: короткое продолжение ровно в месте курсора. */
export const INLINE_SYSTEM_PROMPT = [
  'Ты — автодополнение кода в редакторе. Продолжи код в месте, помеченном <CURSOR>.',
  'Верни ТОЛЬКО код продолжения — без пояснений, без markdown-ограждений, без повторения',
  'уже написанного. Дописывай ровно то, что должно идти следом, одним связным фрагментом.',
  'Если продолжать нечего — верни пустую строку.',
].join('\n');

export interface InlineContext {
  /** Текст до курсора (хвост, ограничен по длине). */
  prefix: string;
  /** Текст после курсора (начало, ограничен по длине). */
  suffix: string;
}

export interface InlineContextLimits {
  maxPrefixChars?: number;
  maxSuffixChars?: number;
}

/**
 * Нарезать текст вокруг позиции курсора. Позиция привычная: строка и
 * столбец, 1-based. Возвращаются хвост до курсора и начало после него, каждый
 * не длиннее своего предела: отдавать модели весь файл и дорого, и бесполезно.
 */
export function inlineContext(
  text: string,
  position: { line: number; column: number },
  limits: InlineContextLimits = {},
): InlineContext {
  const maxPrefix = Math.max(limits.maxPrefixChars ?? DEFAULT_MAX_PREFIX_CHARS, 0);
  const maxSuffix = Math.max(limits.maxSuffixChars ?? DEFAULT_MAX_SUFFIX_CHARS, 0);
  const offset = toOffset(text, position.line, position.column);
  return {
    prefix: text.slice(Math.max(offset - maxPrefix, 0), offset),
    suffix: text.slice(offset, offset + maxSuffix),
  };
}

export interface InlinePromptParts {
  language: string;
  /** Путь файла относительно корня проекта: модели полезен язык и вид файла. */
  relativePath: string;
  prefix: string;
  suffix: string;
}

/** Промпт с контекстом вокруг курсора: модель дописывает ровно в отмеченном месте. */
export function renderInlinePrompt(parts: InlinePromptParts): string {
  const head = [`Язык: ${parts.language}`, `Файл: ${parts.relativePath}`].join('\n');
  const body = `${parts.prefix}${CURSOR_MARKER}${parts.suffix}`;
  return `${head}\n\n\`\`\`\n${body}\n\`\`\``;
}

/**
 * Очистить ответ модели: снять markdown-ограждение (модели любят его добавлять
 * вопреки просьбе) и убрать пустые строки в конце. Начало не трогаем: ведущий
 * перевод строки может быть осмысленным (продолжение с новой строки).
 */
export function cleanCompletion(raw: string): string {
  let text = raw.replace(/\r\n?/g, '\n');

  const fence = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text);
  if (fence) text = fence[1] ?? '';
  else {
    // Ограждение могло остаться незакрытым — снимаем хотя бы открывающую строку.
    text = text.replace(/^\s*```[^\n]*\n/, '');
    text = text.replace(/\n?```\s*$/, '');
  }

  return text.replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
}

/** Токен отмены в том виде, в каком его отдаёт редактор. */
export interface CancellationLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

/**
 * Подождать перед запросом к модели. `true` — пауза прошла, можно спрашивать;
 * `false` — запрос отменён (человек печатает дальше). Отмена прерывает ожидание,
 * иначе на каждую букву копился бы свой висящий запрос.
 */
export function delayOrCancel(ms: number, token: CancellationLike): Promise<boolean> {
  if (token.isCancellationRequested) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      subscription.dispose();
      resolve(true);
    }, ms);
    const subscription = token.onCancellationRequested(() => {
      clearTimeout(timer);
      subscription.dispose();
      resolve(false);
    });
  });
}
