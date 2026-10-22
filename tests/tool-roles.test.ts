import { describe, expect, it } from 'vitest';
import { agentPrompt } from '../src/shared/agent-prompt';
import { AGENT_TOOLS } from '../src/shared/tools';
import { TOOL_ACTION_ROLES, TOOL_FORKS, TOOL_NO_ROLES } from '../src/shared/tool-roles';

/**
 * Сторож ролей: таблица `shared/tool-roles.ts` — утверждение об инструментах,
 * а эти проверки сводят его со схемой и с промптом. Без них таблица была бы
 * третьей правдой рядом с `AGENT_TOOLS` и `agentPrompt`.
 */

const TOOLS = new Map(AGENT_TOOLS.map((tool) => [tool.name as string, tool]));

/** Действия инструмента — ровно то, что видит модель в `enum`. */
function actions(name: string): string[] {
  const action = TOOLS.get(name)?.inputSchema.properties?.action as { enum?: unknown[] } | undefined;
  return (action?.enum ?? []).map(String);
}

/** Слово целиком: `read` не должен совпадать внутри `read_image`. */
function mentions(text: string, name: string): boolean {
  return new RegExp(`(^|[^a-z_])${name}([^a-z_]|$)`).test(text);
}

describe('развилки инструментов', () => {
  it('называют существующие инструменты, и выбор — один из пары', () => {
    for (const fork of TOOL_FORKS) {
      for (const name of fork.pair) expect(TOOLS.has(name), `${fork.ask}: нет инструмента ${name}`).toBe(true);
      expect(fork.pair, fork.ask).toContain(fork.pick);
    }
  });

  it('ответ каждой развилки назван в промпте «Авто»', () => {
    // Схемы в «Авто» не едут — если имени нет и в промпте, модель о выборе не знает.
    const prompt = agentPrompt('auto', { confirm: true });
    for (const fork of TOOL_FORKS) expect(mentions(prompt, fork.pick), fork.ask).toBe(true);
  });
});

describe('перегруженные имена', () => {
  it('enum разбит на роли: каждое действие — ровно в одной', () => {
    for (const [name, roles] of Object.entries(TOOL_ACTION_ROLES)) {
      const declared = Object.values(roles).flat();
      expect(new Set(declared).size, `${name}: действие в двух ролях`).toBe(declared.length);
      expect([...declared].sort(), `${name}: роли разошлись с enum`).toEqual([...actions(name)].sort());
    }
  });

  it('по каждому многодейственному имени решение принято: роли или явный отказ', () => {
    // Раньше проверка молча пропускала имена без ролей — то есть почти все:
    // новый инструмент с двумя действиями проходил незамеченным.
    for (const tool of AGENT_TOOLS) {
      const name = tool.name as string;
      if (actions(name).length < 2) continue;
      const roles = TOOL_ACTION_ROLES[name];
      const waived = TOOL_NO_ROLES[name];
      expect(Boolean(roles) !== Boolean(waived), `${name}: нет ни ролей, ни причины в TOOL_NO_ROLES`).toBe(true);
      if (roles) expect(Object.keys(roles).length, `${name}: роль одна — это не развилка`).toBeGreaterThan(1);
      if (waived) expect(waived.length, `${name}: причина — фраза, а не заглушка`).toBeGreaterThan(20);
    }
  });

  it('отказы не протухли: имя живо и действий по-прежнему несколько', () => {
    for (const name of Object.keys(TOOL_NO_ROLES)) {
      expect(TOOLS.has(name), `TOOL_NO_ROLES: нет инструмента ${name}`).toBe(true);
      expect(actions(name).length, `${name}: действий стало меньше двух — отказ больше не нужен`).toBeGreaterThan(1);
      expect(TOOL_ACTION_ROLES[name], `${name}: и роли, и отказ сразу`).toBeUndefined();
    }
  });
});

describe('ссылки на действия в промпте', () => {
  it('не зовут ни мёртвых имён, ни несуществующих действий', () => {
    // Так `plan (action: ...)` звал в никуда, пока `plan` не слит в `mind` (п.40).
    const prompt = agentPrompt('auto', { confirm: true });
    const refs = [...prompt.matchAll(/([a-z_]+) \(action:? ?([a-z_]+)\)/g)];
    expect(refs.length, 'в промпте не нашлось ссылок вида «имя (action: …)»').toBeGreaterThan(0);
    for (const [whole, name, action] of refs) {
      expect(TOOLS.has(name!), `мёртвое имя в промпте: ${whole}`).toBe(true);
      expect(actions(name!), `${whole}: нет такого действия`).toContain(action);
    }
  });
});
