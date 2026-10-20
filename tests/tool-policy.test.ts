import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_TOOLS, type AgentToolName } from '../src/shared/tools';
import {
  ALWAYS_AVAILABLE,
  PLAN_MODE_TOOLS,
  READ_ONLY_TOOLS,
  isReadOnlyCall,
  isWriteCall,
  SUBAGENT_TOOLS,
  TOOL_POLICIES,
} from '../src/shared/tool-policy';

/**
 * Признаки инструментов были размазаны по пяти спискам в четырёх файлах, и
 * новый инструмент надо было не забыть в каждом. Теперь ответы «где его можно
 * позвать» лежат одной строкой на инструмент, а наборы собираются из таблицы.
 * Здесь стерегутся именно таблица и производные наборы — не поведение
 * инструментов, у которых свои тесты.
 */

const names = AGENT_TOOLS.map((tool) => tool.name);

describe('таблица признаков', () => {
  it('знает каждый инструмент набора', () => {
    expect(Object.keys(TOOL_POLICIES).sort()).toEqual([...names].sort());
  });

  it('у каждого признака есть хотя бы один носитель', () => {
    // Пустой набор — признак, который перестали ставить: тогда «повтор не
    // исполняется» или «в плане можно» молча не работает ни для кого.
    for (const set of [READ_ONLY_TOOLS, PLAN_MODE_TOOLS, SUBAGENT_TOOLS, ALWAYS_AVAILABLE]) {
      expect(set.size).toBeGreaterThan(0);
    }
  });
});

describe('производные наборы', () => {
  it('знают только инструменты из AGENT_TOOLS', () => {
    for (const set of [READ_ONLY_TOOLS, PLAN_MODE_TOOLS, SUBAGENT_TOOLS, ALWAYS_AVAILABLE]) {
      for (const name of set) expect(names).toContain(name as AgentToolName);
    }
  });

  it('подзадача ходит только чтением', () => {
    // Правки и команды остаются за основным агентом: он показывает ревью и
    // спрашивает человека. Исключение одно — web: выдача поиска меняется и
    // стоит денег, поэтому в повторах не кэшируется, но читать её можно.
    for (const name of SUBAGENT_TOOLS) {
      if (name === 'web') continue;
      expect(READ_ONLY_TOOLS.has(name)).toBe(true);
    }
  });

  it('подзадача не зовёт подзадачу', () => {
    expect(SUBAGENT_TOOLS.has('task')).toBe(false);
  });

  it('в плане всё, что доступно подзадаче', () => {
    for (const name of SUBAGENT_TOOLS) expect(PLAN_MODE_TOOLS.has(name)).toBe(true);
  });

  it('в плане нет ничего, что меняет мир', () => {
    for (const name of ['edit', 'create_file', 'delete_file', 'terminal']) {
      expect(PLAN_MODE_TOOLS.has(name)).toBe(false);
    }
  });

  it('без моста окна не обещает работать', () => {
    // Эти инструменты живут в ленте чата и в документной модели: без окна их
    // не исполнить, и «всегда доступен» про них было бы неправдой.
    for (const name of ['ask', 'exit_plan_mode', 'edit', 'open_file', 'terminal']) {
      expect(ALWAYS_AVAILABLE.has(name)).toBe(false);
    }
  });
});

describe('повтор чтения', () => {
  it('у слитого терминала чтение — по действию, а не по имени', () => {
    // Иначе слияние молча отключило бы защиту от зацикливания: `terminal` целиком
    // мир меняет, а чтение вывода и список — нет.
    expect(isReadOnlyCall('terminal', JSON.stringify({ action: 'read', id: 't1' }))).toBe(true);
    expect(isReadOnlyCall('terminal', JSON.stringify({ action: 'output' }))).toBe(true);
    expect(isReadOnlyCall('terminal', JSON.stringify({ action: 'list' }))).toBe(true);
    // Команда и ввод — новая работа, повтор бывает нужен.
    expect(isReadOnlyCall('terminal', JSON.stringify({ action: 'run', command: 'npm test' }))).toBe(false);
    expect(isReadOnlyCall('terminal', JSON.stringify({ action: 'write', id: 't1', data: 'ls\n' }))).toBe(false);
    // Незнакомое действие и битые аргументы не считаются чтением: глушить нечего.
    expect(isReadOnlyCall('terminal', JSON.stringify({ action: 'взмахнуть' }))).toBe(false);
    expect(isReadOnlyCall('terminal', 'не json')).toBe(false);
    // Обычные инструменты чтения работают как раньше.
    expect(isReadOnlyCall('read', JSON.stringify({ path: '/p/a.ts' }))).toBe(true);
    expect(isReadOnlyCall('edit', '{}')).toBe(false);
  });

  it('lsp пишет только действием rename', () => {
    // Имя `lsp` записано как читающее — и для трёх действий это так.
    expect(isReadOnlyCall('lsp', JSON.stringify({ action: 'references', symbol: 'x' }))).toBe(true);
    expect(isReadOnlyCall('lsp', JSON.stringify({ action: 'outline', path: '/p/a.ts' }))).toBe(true);
    expect(isReadOnlyCall('lsp', JSON.stringify({ action: 'rename', symbol: 'x', newName: 'y' }))).toBe(false);
    expect(isWriteCall('lsp', JSON.stringify({ action: 'rename', symbol: 'x', newName: 'y' }))).toBe(true);
    expect(isWriteCall('lsp', JSON.stringify({ action: 'references', symbol: 'x' }))).toBe(false);
  });
});

describe('доступность (canRun)', () => {
  /**
   * `canRun` в сервисе отказывает по умолчанию: инструмент, которого там нет и
   * которого нет в `ALWAYS_AVAILABLE`, модели просто не предложится — тихо, без
   * ошибки. Поэтому проверка читает исходник `canRun` и требует, чтобы про
   * каждый инструмент было сказано хоть что-то: имя, семейство по префиксу
   * (`git_`, `terminal_`, `browser_`) или набор «доступен всегда».
   */
  it('у каждого инструмента есть условие в canRun', () => {
    const source = readFileSync(new URL('../src/main/ai/service.ts', import.meta.url), 'utf8');
    const start = source.indexOf('private canRun(');
    const body = source.slice(start, source.indexOf('private createProvider(', start));
    expect(start).toBeGreaterThan(0);

    const uncovered = names.filter((name) => {
      if (ALWAYS_AVAILABLE.has(name)) return false;
      if (body.includes(`'${name}'`)) return false;
      const cut = name.indexOf('_');
      return cut <= 0 || !body.includes(name.slice(0, cut + 1));
    });
    expect(uncovered).toEqual([]);
  });
});

describe('расширение набора', () => {
  /**
   * Пометка «подключён в набор» и пересборка набора — один раз на прогон, а не
   * на каждый вызов. Живой прогон дал 91 пометку в 91 ответе `terminal` и
   * `git_write`: эти инструменты не входят в группы «Авто», поэтому «скрыт
   * набором» верно для них всегда. Модель читала это как «набор всё время
   * меняется», и пометка ехала в каждом ответе до конца прогона.
   *
   * Проверяем по исходнику: сервис целиком не поднять без Electron.
   */
  it('widenedNow ставится только когда инструмент подключается впервые', () => {
    const source = readFileSync(new URL('../src/main/ai/service.ts', import.meta.url), 'utf8');
    const start = source.indexOf('const rosterOnly = isRosterTool(');
    const body = source.slice(start, source.indexOf('const denied =', start));
    expect(start).toBeGreaterThan(0);
    // Признак «впервые» обязан быть — и обязан проверяться до добавления в набор.
    expect(body).toContain('const first = !onDemandTools.has(call.name)');
    expect(body).toContain('if (!rosterOnly && first)');
  });
});
