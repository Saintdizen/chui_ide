import { describe, expect, it } from 'vitest';
import { runTool, type ToolContext } from '../src/main/ai/agent-tools';
import { AGENT_TOOLS } from '../src/shared/tools';

/**
 * Слитые инструменты: `browser`, `terminal`, `edit`, `lsp` с полем `action`.
 *
 * Схема обещает те действия, которые разбирает код, промах по действию называет
 * допустимые, а недостающий аргумент возвращается отказом с именем поля, а не
 * «не задан аргумент» из глубины обработчика.
 */

const spec = (name: string) => AGENT_TOOLS.find((tool) => tool.name === name)!;

describe('слитые инструменты: схема', () => {
  it('объявленные действия совпадают с разобранными', () => {
    const actions = (name: string): string[] => {
      const property = spec(name).inputSchema.properties.action as { enum?: string[] };
      return property.enum ?? [];
    };
    expect(actions('browser')).toEqual(['open', 'snapshot', 'click', 'type', 'evaluate', 'zoom', 'close']);
    expect(actions('lsp')).toEqual(['references', 'definition', 'outline', 'rename']);
    // Терминала здесь нет: его восемь действий — восемь имён. Это сторожит
    // соседний тест — чтобы слитое имя не вернулось тихо.
    // Старых имён в наборе больше нет: иначе схема и обработчик разъехались бы.
    const gone = ['browser_open', 'terminal_start', 'git_status', 'run_terminal', 'apply_patch', 'file_outline'];
    for (const old of gone) {
      expect(AGENT_TOOLS.some((tool) => tool.name === old)).toBe(false);
    }
  });

  it('у `terminal` нет `action`: он разведён по именам', () => {
    expect(spec('terminal').inputSchema.properties.action).toBeUndefined();
    expect(spec('terminal').inputSchema.required).toEqual(['command']);
    for (const name of ['terminalOpen', 'terminalOutput', 'terminalWrite', 'terminalStop', 'terminalList']) {
      expect(spec(name).inputSchema.properties.action).toBeUndefined();
    }
  });

  it('обязателен только action: остальные поля зависят от действия', () => {
    for (const name of ['browser', 'lsp']) {
      expect(spec(name).inputSchema.required).toEqual(['action']);
    }
  });
});

describe('слитые инструменты: разбор', () => {
  const ctx = { workspace: {} } as unknown as ToolContext;

  it('незнакомое имя называет доступные', async () => {
    // Имена терминала теперь самостоятельные: слитое `terminal` с `action` больше
    // не принимается, и модель должна узнать это из ответа, а не гадать.
    const outcome = await runTool(ctx, 'terminal', JSON.stringify({ action: 'взмахнуть' }));
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('command');
  });

  it('terminal: команда и задание — разные имена', async () => {
    // Команда без `command` и остановка без `id` отказывают до обработчика — там
    // контекста нет, и «не задан аргумент» из глубины читалось бы как поломка.
    const run = await runTool(ctx, 'terminal', JSON.stringify({}));
    expect(run.summary).toContain('command');
    const stop = await runTool(ctx, 'terminalStop', JSON.stringify({}));
    expect(stop.summary).toContain('id');
    // Вывод без id — список заданий, а не ошибка: реестр заданий есть всегда.
    const jobs = await runTool(
      { ...ctx, jobs: { list: () => [], get: () => undefined } } as unknown as ToolContext,
      'terminalOutput',
      JSON.stringify({}),
    );
    expect(jobs.ok).toBe(true);
    expect(jobs.summary).toContain('заданий');
  });

  it('edit: форму выбирает сама правка, а не отдельное поле', async () => {
    // Адрес — якорь или четыре позиции. Промахи называются словами: «не хватает
    // адреса», «позиций не все», «в одном файле обе формы» — по ним и чинят.
    const neither = await runTool(
      ctx,
      'edit',
      JSON.stringify({ edits: [{ path: '/p/a.ts', edits: [{ newText: 'x' }] }] }),
    );
    expect(neither.ok).toBe(false);
    expect(neither.summary).toContain('oldText');

    const partial = await runTool(
      ctx,
      'edit',
      JSON.stringify({ edits: [{ path: '/p/a.ts', edits: [{ startLine: 1, newText: 'x' }] }] }),
    );
    expect(partial.summary).toContain('не все');

    const mixed = await runTool(
      ctx,
      'edit',
      JSON.stringify({
        edits: [
          {
            path: '/p/a.ts',
            edits: [
              { oldText: 'a', newText: 'b' },
              { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2, newText: 'c' },
            ],
          },
        ],
      }),
    );
    expect(mixed.summary).toContain('два вызова');
  });

  it('edit со старым action не тупик: create и move делегируются в file', async () => {
    // Схема `action` больше не объявляет (дубли сняты: создание, перемещение
    // и удаление живут у `file`), но сохранённые беседы продолжаются. Такой
    // вызов доходит до разбора и отказывает по делу — именем поля, а не
    // «неизвестное значение аргумента».
    const create = await runTool(ctx, 'edit', JSON.stringify({ action: 'create' }));
    expect(create.ok).toBe(false);
    expect(create.summary).toContain('path');
    const move = await runTool(ctx, 'edit', JSON.stringify({ action: 'move' }));
    expect(move.summary).toContain('from');
  });

  it('недостающий аргумент назван по имени поля', async () => {
    const outcome = await runTool(ctx, 'browser', JSON.stringify({ action: 'click' }));
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('ref');
  });

  it('без действия вызов тоже объясняется', async () => {
    const outcome = await runTool(ctx, 'lsp', JSON.stringify({}));
    expect(outcome.ok).toBe(false);
    // Отказ приходит до обработчика: схема требует action, и это названо прямо.
    expect(outcome.summary).toContain('action');
  });

  it('lsp: скелет файла спрашивает только path', async () => {
    // Символ нужен ссылкам и объявлению, а оглавлению — файл. Общая схема
    // проверяет лишь action, остальное называет отказ.
    const outcome = await runTool(ctx, 'lsp', JSON.stringify({ action: 'outline' }));
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('path');
  });

  it('lsp: незнакомое действие называет допустимые', async () => {
    const outcome = await runTool(ctx, 'lsp', JSON.stringify({ action: 'hover' }));
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('references, definition, outline');
  });
});
