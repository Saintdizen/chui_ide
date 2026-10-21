import { describe, expect, it } from 'vitest';
import { runTool, type ToolContext } from '../src/main/ai/agent-tools';
import { AGENT_TOOLS } from '../src/shared/tools';

/**
 * Каждое действие слитого инструмента из `enum` схемы доходит до обработчика.
 *
 * Схема обещает список действий; промах «незнакомое действие» значит, что
 * обещанного нет в `switch`. Проверяем без мока рабочей папки: пустой контекст
 * отказывает по своим причинам (нет `path`, нет окна), но только не «неизвестным
 * действием» — именно его и ловим.
 */

const ctx = { workspace: {} } as unknown as ToolContext;

function actionsOf(name: string): string[] {
  const spec = AGENT_TOOLS.find((tool) => tool.name === name)!;
  const property = spec.inputSchema.properties.action as { enum?: string[] } | undefined;
  return property?.enum ?? [];
}

/** Инструменты, у которых действие объявлено в схеме. */
const WITH_ACTION = ['browser', 'terminal', 'lsp', 'checks', 'mcp', 'web', 'file', 'show', 'mind', 'search', 'edit'];

describe('действия схемы доходят до обработчика', () => {
  for (const name of WITH_ACTION) {
    it(`${name}: все действия из enum известны разбору`, async () => {
      const actions = actionsOf(name);
      expect(actions.length).toBeGreaterThan(0);
      for (const action of actions) {
        const outcome = await runTool(ctx, name, JSON.stringify({ action }));
        // Неизвестное действие — единственный отказ, который бы значил разъезд.
        expect(`${name}/${action}: ${outcome.detail ?? outcome.summary}`).not.toContain('Неизвестное действие');
      }
    });
  }
});
