import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_TOOLS, type AgentToolName } from '../src/shared/tools';
import {
  ALWAYS_AVAILABLE,
  PLAN_MODE_TOOLS,
  READ_ONLY_TOOLS,
  isReadOnlyCall,
  isCacheableReadCall,
  isWriteCall,
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

describe('повторы живого вывода', () => {
  it('права чтения не превращают опрос процесса в кешированный результат', () => {
    for (const name of ['terminalList', 'terminalOutput']) {
      const args = JSON.stringify({ id: 'job-1' });
      expect(isReadOnlyCall(name, args)).toBe(true);
      // Только опрос живого процесса: список меняется сам, его можно кешировать.
      expect(isCacheableReadCall(name, args)).toBe(name === 'terminalList');
    }
    expect(isCacheableReadCall('read', '{"path":"a.ts"}')).toBe(true);
    expect(isCacheableReadCall('read', '{"path":"a.ts","force":true}')).toBe(false);
    expect(isCacheableReadCall('read', '{"path":"a.ts","force":"true"}')).toBe(false);
  });
});

describe('таблица признаков', () => {
  it('знает каждый инструмент набора', () => {
    expect(Object.keys(TOOL_POLICIES).sort()).toEqual([...names].sort());
  });

  it('у каждого признака есть хотя бы один носитель', () => {
    // Пустой набор — признак, который перестали ставить: тогда «повтор не
    // исполняется» или «в плане можно» молча не работает ни для кого.
    for (const set of [READ_ONLY_TOOLS, PLAN_MODE_TOOLS, ALWAYS_AVAILABLE]) {
      expect(set.size).toBeGreaterThan(0);
    }
  });
});

describe('производные наборы', () => {
  it('знают только инструменты из AGENT_TOOLS', () => {
    for (const set of [READ_ONLY_TOOLS, PLAN_MODE_TOOLS, ALWAYS_AVAILABLE]) {
      for (const name of set) expect(names).toContain(name as AgentToolName);
    }
  });

  it('в плане нет ничего, что меняет мир', () => {
    for (const name of ['edit', 'create_file', 'delete_file', 'terminal']) {
      expect(PLAN_MODE_TOOLS.has(name)).toBe(false);
    }
  });

  it('терминал, меняющий мир, — не в плане', () => {
    for (const name of ['terminal', 'terminalOpen', 'terminalWrite', 'terminalStop', 'terminalOutput']) {
      // Всё, что трогает живой процесс, в плане не предлагается: там можно только смотреть.
      expect(PLAN_MODE_TOOLS.has(name)).toBe(false);
    }
    // А список сессий ничего не меняет — ему в плане можно, как `read`.
    expect(PLAN_MODE_TOOLS.has('terminalList')).toBe(true);
  });

  it('без моста окна не обещает работать', () => {
    // Эти инструменты живут в ленте чата и в документной модели: без окна их
    // не исполнить, и «всегда доступен» про них было бы неправдой.
    for (const name of ['ask', 'exit_plan_mode', 'edit', 'open_file', 'terminalOutput']) {
      expect(ALWAYS_AVAILABLE.has(name)).toBe(false);
    }
  });
});

describe('повтор чтения', () => {
  it('у терминала чтение — отдельное имя, а не флаг вызова', () => {
    // Раньше это решал `action`; после развода имён правило держится именем:
    // иначе сторож на повторы молча отключился бы вместе со слиянием.
    expect(isReadOnlyCall('terminalOutput', JSON.stringify({ id: 't1' }))).toBe(true);
    expect(isReadOnlyCall('terminalList', '{}')).toBe(true);
    // Команда и ввод — новая работа, повтор бывает нужен.
    expect(isReadOnlyCall('terminal', JSON.stringify({ command: 'npm test' }))).toBe(false);
    expect(isReadOnlyCall('terminalWrite', JSON.stringify({ id: 't1', data: 'ls\n' }))).toBe(false);
    // Старый вызов со слитым действием — уже не команда: он не выполнится.
    expect(isReadOnlyCall('terminal', JSON.stringify({ action: 'read', id: 't1' }))).toBe(false);
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
   * `canRunTool` (`main/ai/available-tools.ts`) отказывает по умолчанию:
   * инструмент, которого там нет и которого нет в `ALWAYS_AVAILABLE`, модели
   * просто не предложится — тихо, без ошибки. Поэтому проверка читает
   * исходник и требует, чтобы про каждый инструмент было сказано хоть что-то:
   * имя, семейство по префиксу (`terminal_`, `browser_`) или набор «доступен
   * всегда».
   *
   * Условия живут в отдельном модуле нарочно: пока они были методом сервиса,
   * проверять их без настроек было нельзя, и тест читал исходник по границам
   * `private canRun(`..`private createProvider(`.
   */
  it('у каждого инструмента есть условие в canRunTool', () => {
    const source = readFileSync(new URL('../src/main/ai/available-tools.ts', import.meta.url), 'utf8');
    const start = source.indexOf('export function canRunTool(');
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start);

    const uncovered = names.filter((name) => {
      if (ALWAYS_AVAILABLE.has(name)) return false;
      if (body.includes(`'${name}'`)) return false;
      if (name.startsWith('terminal')) return false; // Семья терминала — префиксом
      const cut = name.indexOf('_');
      return cut <= 0 || !body.includes(name.slice(0, cut + 1));
    });
    expect(uncovered).toEqual([]);
  });
});

describe('расширение набора', () => {
  /**
   * Пометка «подключён в набор» и пересборка набора — один раз на прогон, а не
   * на каждый вызов. Живой прогон дал 91 пометку в 91 ответе `terminal`:
   * он не входит в группы «Авто», поэтому «скрыт
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
