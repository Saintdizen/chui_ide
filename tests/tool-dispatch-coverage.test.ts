import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_TOOLS, type AgentToolName } from '../src/shared/tools';

/**
 * Страж схемы и веток dispatchTool.
 *
 * Тип `AgentToolName` и `switch` связаны только договорённостью: если добавить
 * инструмент в схему и забыть ветку, typecheck смолчит, а модель получит
 * `unknownTool` в рантайме. Здесь сверяем оба списка и падаем на расхождении.
 */
const SOURCE = fileURLToPath(new URL('../src/main/ai/agent-tools.ts', import.meta.url));

// Ветки берём только из `dispatchTool`: в файле есть и другие `switch`
// (обработчики попыток), и их `case` к реестру отношения не имеют.
function dispatchCases(text: string): Set<string> {
  const start = text.indexOf('async function dispatchTool');
  expect(start, 'dispatchTool не найдена в agent-tools.ts').toBeGreaterThan(-1);
  const body = text.slice(start);
  const names = new Set<string>();
  for (const match of body.matchAll(/case '([a-zA-Z_]+)'/g)) {
    const name = match.at(1);
    // Группа всегда есть, но тип об этом не знает; без проверки — лишний `!`.
    if (name !== undefined) names.add(name);
  }
  return names;
}

describe('схема инструментов и dispatchTool', () => {
  const text = readFileSync(SOURCE, 'utf8');
  const cases = dispatchCases(text);

  it('каждое имя из AGENT_TOOLS имеет ветку в dispatchTool', () => {
    const missing = AGENT_TOOLS.map((tool) => tool.name).filter((name) => !cases.has(name));
    expect(missing, 'инструмент объявлен, но не обрабатывается').toEqual([]);
  });

  it('в dispatchTool нет веток для инструментов вне схемы', () => {
    const declared = new Set<string>(AGENT_TOOLS.map((tool) => tool.name));
    const extra = [...cases].filter((name) => !declared.has(name));
    expect(extra, 'ветка есть, а в схеме нет').toEqual([]);
  });

  it('имён ровно столько, сколько объявляет тип', () => {
    // Число-свидетель: ловит удаление инструмента из схемы без правки типа.
    const expected: Record<AgentToolName, true> = Object.fromEntries(
      AGENT_TOOLS.map((tool) => [tool.name, true]),
    ) as Record<AgentToolName, true>;
    expect(Object.keys(expected)).toHaveLength(28);
  });
});
