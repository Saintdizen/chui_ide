import { describe, expect, it } from 'vitest';
import { runTool } from '../src/main/ai/agent-tools.js';
import type { ToolContext } from '../src/main/ai/tool-context.js';
import type { SkillEntry } from '../src/shared/skills.js';

const entry: SkillEntry = {
  name: 'release',
  description: 'Выпуск версии',
  path: '/w/.chui/skills/release/SKILL.md',
  scope: 'workspace',
};

// Только `skills` — остальное контексту `skill` и не нужно. Чужой контекст
// живёт в `agent-tools.test.ts`, здесь проверяется ровно эта ветка.
function ctx(skills?: ToolContext['skills']): ToolContext {
  return { workspaceRoot: '/w', skills } as unknown as ToolContext;
}

async function call(skills: ToolContext['skills'], args: Record<string, unknown>) {
  return runTool(ctx(skills), 'skill', JSON.stringify(args));
}

describe('tool skill: успешный путь', () => {
  it('нет библиотеки — отказ с причиной', async () => {
    const r = await call(undefined, {});
    expect(r.ok).toBe(false);
    // Причина обязана быть: пустой отказ агент прочитает как «навыков нет».
    expect(r.summary).toMatch(/навык/i);
  });

  it('без имени — список навыков, а не ошибка', async () => {
    const r = await call({ list: async () => [entry], read: async () => null }, {});
    expect(r.ok).toBe(true);
    // Каталог приходит в detail (agent-tools.ts:381), в summary — только счёт.
    const shown = `${r.summary}\n${r.detail ?? ''}`;
    expect(shown).toContain('release');
    expect(shown).toContain('Выпуск версии');
  });

  it('пустой каталог — говорит словами, а не пустотой', async () => {
    const r = await call({ list: async () => [], read: async () => null }, {});
    expect(r.ok).toBe(true);
    expect(r.summary).toBeTruthy();
  });

  it('известное имя — отдаёт тело навыка', async () => {
    const r = await call(
      { list: async () => [entry], read: async () => ({ entry, body: 'ШАГИ ВЫПУСКА' }) },
      { name: 'release' },
    );
    expect(r.ok).toBe(true);
    // Тело — в detail (agent-tools.ts:398): одна строка summary его не вместит.
    expect(r.detail).toContain('ШАГИ ВЫПУСКА');
  });

  it('неизвестное имя — отказ, а не пустой успех', async () => {
    const r = await call({ list: async () => [entry], read: async () => null }, { name: 'нет-такого' });
    expect(r.ok).toBe(false);
    expect(r.summary).toBeTruthy();
  });
});

describe('tool: внутренний сбой не выходит сырым в агент', () => {
  it('сбой `app.getPath` переводится в понятную причину', async () => {
    // Так падает любая подсистема, которая живёт в Electron: вне приложения
    // `app` — undefined. Агент не должен видеть «reading \'getPath\'» — это
    // читается как баг IDE, а не как «нужен редактор».
    const boom = new Error("Cannot read properties of undefined (reading 'getPath')");
    const r = await runTool(
      {
        workspaceRoot: '/w',
        skills: {
          list: async () => {
            throw boom;
          },
        },
      } as unknown as ToolContext,
      'skill',
      '{}',
    );
    expect(r.ok).toBe(false);
    expect(r.summary).not.toContain('getPath');
    expect(r.summary).toMatch(/редактор/i);
  });

  it('свой внятный текст отказа не подменяется', async () => {
    const boom = new Error('Путь вне рабочей папки');
    const r = await runTool(
      {
        workspaceRoot: '/w',
        skills: {
          list: async () => {
            throw boom;
          },
        },
      } as unknown as ToolContext,
      'skill',
      '{}',
    );
    expect(r.summary).toBe('Путь вне рабочей папки');
  });
});
