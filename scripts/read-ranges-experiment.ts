/**
 * Проверка спроса на read(ranges), без расширения публичной схемы.
 * Та же выборка и --manifest, что у остальных переписей. Запросы в одном шаге
 * можно объединять без предположения о независимости следующих шагов.
 * Соседние шаги считаем лишь кандидатами: второй мог зависеть от первого.
 */
import { estimateTextTokens } from '../src/shared/context-fit';
import { AGENT_TOOLS, toOpenAiTools, type AgentToolSpec } from '../src/shared/tools';
import { argumentsOf, censusHeader, loadCensus } from './census-data';

const sample = loadCensus();
console.log(censusHeader(sample));
const read = AGENT_TOOLS.find((tool) => tool.name === 'read')!;
const proposed: AgentToolSpec = {
  ...read,
  inputSchema: {
    ...read.inputSchema,
    properties: {
      ...read.inputSchema.properties,
      ranges: {
        type: 'array',
        description: 'One file: several line ranges, 1-based, inclusive. Not with paths.',
        items: {
          type: 'object',
          properties: { startLine: { type: 'number' }, endLine: { type: 'number' } },
          required: ['startLine', 'endLine'],
        },
      },
    },
  },
};
const price = (spec: AgentToolSpec) => estimateTextTokens(JSON.stringify(toOpenAiTools([spec])));
let groups = 0;
let callsSaved = 0;
let adjacentCandidates = 0;
let steps = 0;
for (const messages of sample.messages) {
  let previous: string | undefined;
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.toolCalls?.length) continue;
    steps += 1;
    const paths = new Map<string, number>();
    for (const call of message.toolCalls) {
      if (call.name !== 'read') continue;
      const args = argumentsOf(call.arguments ?? '');
      if (
        typeof args.path !== 'string' ||
        !Number.isInteger(args.startLine) ||
        !Number.isInteger(args.endLine) ||
        Number(args.startLine) < 1 ||
        Number(args.endLine) < Number(args.startLine)
      )
        continue;
      paths.set(args.path, (paths.get(args.path) ?? 0) + 1);
    }
    for (const count of paths.values()) {
      if (count > 1) {
        groups += 1;
        callsSaved += count - 1;
      }
    }
    const only = message.toolCalls.length === 1 && paths.size === 1 ? [...paths.keys()][0] : undefined;
    if (only && only === previous) adjacentCandidates += 1;
    previous = only;
  }
}
const delta = price(proposed) - price(read);
console.log(
  `Экспериментальная схема: +${delta} оценочных токенов на запрос, +${delta * steps} за ${steps} шагов без учёта кеша.`,
);
console.log(`Независимые группы в одном шаге: ${groups}; можно убрать вызовов: ${callsSaved} (не запросов модели).`);
console.log(`Соседние шаги с диапазоном одного файла: ${adjacentCandidates}; независимость НЕ доказана.`);
console.log(
  'Решение: публичную схему не расширять до парных живых прогонов с меньшей общей ценой и без потери качества.',
);
