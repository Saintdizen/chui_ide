import { estimateTextTokens } from './context-fit';
/**
 * «Что попало в сводку»: из чего состоит сжатие беседы.
 *
 * Сжатие было немым: «было сообщений: 40» — и всё. Человек не понимал, о чём
 * именно теперь помнит модель, и не мог решить, хватает ли резюме. Считаем то,
 * что легко проверить глазами: сколько было, сколько вопросов, с чего началось
 * и чем закончилось, сколько файлов тронуто.
 */
export interface CompactionFacts {
  messages: number;
  questions: number;
  /**
   * Токены до и после сжатия. Смысл сжатия — освободить место в окне, и без
   * этой пары человек не знает, помогло ли оно: «40 сообщений» ничего не
   * говорит о том, стало легче или нет.
   */
  tokensBefore: number;
  tokensAfter: number;
  /** Первый и последний вопрос в свёрнутой части — по одной строке, сокращённые. */
  firstQuestion: string;
  lastQuestion: string;
  files: number;
}

/** Длина подписи вопроса: это ориентир в заголовке, а не сам вопрос. */
export const QUESTION_EXCERPT = 60;

export function compactionFacts(
  history: readonly { role: string; content: string }[],
  options: { files?: number; compacted?: readonly { role: string; content: string }[] } = {},
): CompactionFacts {
  const asked = history.filter((message) => message.role === 'user');
  const files = options.files ?? 0;
  const tokensBefore = history.reduce((sum, message) => sum + estimateTextTokens(message.content ?? ''), 0);
  // После сжатия в истории остаются резюме и последние ходы — `history` здесь
  // уже сжатая, поэтому считаем по ней же, а не по `before`.
  const tokensAfter = options.compacted
    ? options.compacted.reduce((sum, message) => sum + estimateTextTokens(message.content ?? ''), 0)
    : tokensBefore;
  return {
    messages: history.length,
    questions: asked.length,
    tokensBefore,
    tokensAfter,
    firstQuestion: excerpt(asked[0]?.content),
    // Один вопрос — не повторяем его дважды: `compactionLines` это учтёт.
    lastQuestion: excerpt(asked[asked.length - 1]?.content),
    files: files > 0 ? files : 0,
  };
}

function excerpt(text: string | undefined): string {
  const line = (text ?? '').replace(/\s+/g, ' ').trim();
  if (line.length <= QUESTION_EXCERPT) return line;
  return `${line.slice(0, QUESTION_EXCERPT - 1)}…`;
}

/**
 * Строки для отметки в ленте. Пустой беседы не бывает — сжатие зовут только
 * тогда, когда есть что сжимать, — но строки терпят и пустоту: одна `messages`.
 */
export function compactionLines(facts: CompactionFacts): string[] {
  const lines: string[] = [];
  lines.push(`сообщений: ${facts.messages} · вопросов: ${facts.questions}`);
  if (facts.firstQuestion && facts.lastQuestion && facts.lastQuestion !== facts.firstQuestion) {
    lines.push(`о чём: «${facts.firstQuestion}» … «${facts.lastQuestion}»`);
  } else if (facts.firstQuestion) {
    lines.push(`о чём: «${facts.firstQuestion}»`);
  }
  if (facts.files > 0) lines.push(`затронуто файлов: ${facts.files}`);
  // Токены — только если их считали: у старого вызова их нет в фактах.
  if (facts.tokensBefore > 0) {
    const freed = facts.tokensBefore - facts.tokensAfter;
    lines.push(
      freed > 0
        ? `токенов: ${facts.tokensBefore} → ${facts.tokensAfter} (освободилось ${freed})`
        : `токенов: ${facts.tokensBefore} → ${facts.tokensAfter}`,
    );
  }
  return lines;
}
