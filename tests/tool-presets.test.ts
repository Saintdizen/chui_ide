import { describe, expect, it } from 'vitest';
import { estimateTextTokens } from '../src/shared/context-fit';
import { AGENT_TOOLS, toOpenAiTools } from '../src/shared/tools';
import {
  DEFAULT_TOOL_PRESET,
  TOOL_GROUPS,
  TOOL_PRESETS,
  isRosterTool,
  presetToolNames,
  rosterLine,
  rosterNames,
  sanitizeToolPreset,
  toolPresetAllows,
  toolPresetNote,
  toolPresetSpec,
  WIDENED_TOOLS,
  type ToolPresetId,
} from '../src/shared/tool-presets';

/**
 * Наборы инструментов: схемы едут в КАЖДОМ запросе, поэтому состав набора — это
 * прямой расход токенов. Страж держит три вещи: группы разложены без опечаток и
 * без дыр (новый инструмент не потеряется в узких наборах), узкие наборы
 * действительно узкие по смыслу (никаких правок и команд в «только чтение») и
 * дешевле полного (иначе выбор ничего не экономит).
 */

const names = new Set(AGENT_TOOLS.map((tool) => tool.name));

/** Вес схем набора — так же, как его считает service: ростер и `WIDENED_TOOLS` вычтены. */
function presetTokens(preset: ToolPresetId): number {
  const allowed = presetToolNames(preset);
  const tools = AGENT_TOOLS.filter(
    (tool) =>
      (allowed === null || allowed.has(tool.name)) &&
      !isRosterTool(preset, tool.name) &&
      !WIDENED_TOOLS.includes(tool.name),
  );
  return estimateTextTokens(JSON.stringify(toOpenAiTools(tools)));
}

const tokens = Object.fromEntries(TOOL_PRESETS.map((item) => [item.id, presetTokens(item.id)])) as Record<
  ToolPresetId,
  number
>;

describe('наборы инструментов агента', () => {
  it('группы ссылаются только на существующие инструменты', () => {
    for (const group of TOOL_GROUPS) {
      for (const name of group.names) {
        expect(names, `группа «${group.label}»: неизвестный инструмент ${name}`).toContain(name);
      }
    }
  });

  it('инструмент не разложен в две группы', () => {
    // Один инструмент в двух группах — значит, состав пресетов зависит от порядка
    // групп, а не от смысла: такой дубль легко не заметить.
    const seen = new Map<string, string>();
    for (const group of TOOL_GROUPS) {
      for (const name of group.names) {
        expect(seen.get(name), `${name}: группы «${seen.get(name)}» и «${group.label}»`).toBeUndefined();
        seen.set(name, group.label);
      }
    }
  });

  it('группы покрывают весь набор инструментов', () => {
    // Полный пресет работает и без групп (он «без ограничения»), но новый
    // инструмент, забытый в группах, молча пропал бы из всех узких наборов.
    const covered = new Set(TOOL_GROUPS.flatMap((group) => group.names));
    const missed = [...names].filter((name) => !covered.has(name));
    expect(missed, `не разложены по группам: ${missed.join(', ')}`).toEqual([]);
  });

  it('все пресеты ссылаются на существующие группы', () => {
    const groups = new Set(TOOL_GROUPS.map((group) => group.id));
    for (const preset of TOOL_PRESETS) {
      for (const id of preset.groups ?? []) {
        expect(groups, `пресет «${preset.label}»: неизвестная группа ${id}`).toContain(id);
      }
    }
  });

  it('пресет «только чтение» не даёт ничего менять', () => {
    const allowed = presetToolNames('read')!;
    const mutating = ['edit', 'create_file', 'delete_file', 'move_file', 'replace_in_files', 'terminal', 'browser'];
    for (const name of mutating) {
      expect(allowed.has(name), `«чтение» не должно предлагать ${name}`).toBe(false);
    }
    // А читать и спрашивать — обязано: иначе набор бесполезен.
    for (const name of ['read', 'search', 'lsp', 'mind']) {
      expect(allowed.has(name)).toBe(true);
    }
  });

  it('наборы вложены: минимум ⊆ чтение ⊆ правка', () => {
    const minimal = presetToolNames('minimal')!;
    const read = presetToolNames('read')!;
    const edit = presetToolNames('edit')!;
    for (const name of minimal) expect(read.has(name), `«чтение» не содержит ${name}`).toBe(true);
    for (const name of read) expect(edit.has(name), `«правка» не содержит ${name}`).toBe(true);
    // Строгость: каждый следующий набор шире предыдущего, иначе выбор фиктивный.
    expect(edit.size).toBeGreaterThan(read.size);
    expect(read.size).toBeGreaterThan(minimal.size);
  });

  it('полный набор ничего не ограничивает', () => {
    expect(presetToolNames('full')).toBeNull();
    expect(toolPresetAllows('full', 'terminal')).toBe(true);
    // Чужое имя (внешний инструмент MCP) полный набор тоже пропускает: судить о
    // нём по нашему списку нельзя, решает это `canRun` и настройки MCP.
    expect(toolPresetAllows('full', 'mcp_что_то')).toBe(true);
    expect(toolPresetAllows('read', 'mcp_что_то')).toBe(false);
  });

  it('узкие наборы заметно дешевле полного', () => {
    // Схемы узких наборов не трогает ни ростер, ни `WIDENED_TOOLS` (terminal там
    // и так нет), поэтому их разрыв с полным остался прежним: 0,74 и 0,42.
    // Разница узких наборов с полным — в именах, а не в схемах: `checks`,
    // `run_tests`, `lsp`, `show` и `web` едут строкой ростера, то есть нулём.
    // Поэтому здесь «не дороже»: наборы вложены по составу (проверено выше),
    // а цена схем у «Чтения» и «Минимума» совпадает по построению.
    // Доля 0.79, а не 0.75 (27.10): сжали описания аргументов `read` — полный набор
    // похудел до 518, а «Чтение» до 384, и доля выросла. Порог сторожит
    // порядок «узкое много дешевле», а не точное соотношение.
    expect(tokens.read).toBeLessThanOrEqual(tokens.full * 0.79);
    expect(tokens.minimal).toBeLessThanOrEqual(tokens.read);
    // «Правка» и «Все инструменты» дешевеют вместе: у обоих вычтены те же
    // `terminal` и `mcp`, а разница — сеть и браузер. Поэтому
    // страж держит «не дороже»: строгое «меньше» падало бы на шуме.
    expect(tokens.edit).toBeLessThanOrEqual(tokens.full);
    // Абсолютный потолок чтения: ради этого выбор и заводился (замер — ≈2 400).
    expect(tokens.read).toBeLessThan(6_500);
  });

  it('полный набор не толстеет незаметно', () => {
    // Каждая лишняя фраза в описании аргумента платится в каждом запросе: замер
    // на проводе — 7 850 токенов. Сторож держит потолок с запасом в 2%: обычная
    // правка пройдёт, а возврат «объясню подробнее» на десяток описаний — нет.
    expect(tokens.full).toBeLessThan(8_000);
  });

  it('набор «Авто» есть, он по умолчанию и расширяется сам', () => {
    // Смысл набора — платить меньше за шаг, не отнимая возможность: скрытое
    // подключается вызовом по имени (см. `widen` и `service`), поэтому цена
    // падает без обещания « этого инструмента у меня нет».
    const auto = toolPresetSpec('auto');
    expect(DEFAULT_TOOL_PRESET).toBe('auto');
    expect(auto.widen).toBe(true);
    expect(auto.groups).not.toBeNull();
    // Всё, что меняет проект, в нём есть: правки прятать нельзя — это работа.
    for (const name of ['edit', 'read']) {
      expect(presetToolNames('auto')?.has(name), `в «Авто» нет ${name}`).toBe(true);
    }
    // `run_tests` и `list` нужны почти каждому прогону, но их схемы (205 и 168
    // ток.) не окупаются: строка ростера называет `target`, `glob`, `limit` и
    // стоит ~15 ток. Докачки больше нет (п.45): она обнуляла кеш префикса.
    for (const name of ['run_tests', 'list']) {
      expect(presetToolNames('auto')?.has(name), `«Авто» отдал ${name} схемой`).toBe(false);
      expect(rosterNames('auto'), `${name} нет в ростере`).toContain(name);
    }
    expect(WIDENED_TOOLS, 'докачка схем отменена').toEqual([]);
    // Спросить человека тоже можно, но строкой ростера: форма вызова у него
    // простая, а схема стоила 121 токен в каждом запросе.
    expect(rosterNames('auto')).toContain('mind');
    // А дорогое и редкое — спрятано: именно на нём и экономия.
    for (const name of ['terminal', 'browser']) {
      expect(presetToolNames('auto')?.has(name), `в «Авто» не должно быть ${name}`).toBe(false);
    }
    // «Авто» дешевле полного по схемам ровно на столько, сколько у полного
    // осталось неперечисленных: остальные имена — ростер, то есть ноль.
    expect(tokens.auto).toBeLessThanOrEqual(tokens.full);
  });

  it('неизвестное значение набора считается полным', () => {
    expect(sanitizeToolPreset('read')).toBe('read');
    expect(sanitizeToolPreset('auto')).toBe('auto');
    // Умолчание для новых — `auto`, но чужое значение в старой настройке или
    // беседе — «все»: сужение на угад отняло бы возможность, о которой не просили.
    expect(sanitizeToolPreset(undefined)).toBe('full');
    expect(sanitizeToolPreset('nonsense')).toBe('full');
  });

  it('скрытое в «Авто» названо в ростере и всё ещё зовётся по имени', () => {
    // Схема скрыта ради цены, но не запрещена. Если имя не назвать в подсказке,
    // инструмент пропадёт совсем: модель не узнает о нём ни из схемы, ни из промпта.
    const auto = toolPresetSpec('auto');
    const hidden = auto.except ?? [];
    expect(hidden.length).toBeGreaterThan(0);
    const note = toolPresetNote('auto');
    for (const name of hidden) {
      // Ростера мало: без формы вызова первый вызов уйдёт наугад, а схема
      // теперь не приедет вовсе (`WIDENED_TOOLS` пуст, п.45) — форма в строке
      // единственное, что увидит модель. Сверяем начало формы.
      // Свёрнутые в семью (`terminal(Open|Output|…, command, cwd?)`) ищем по
      // тексту самой записи: хвост `Output` в ней есть, отдельной `terminalOutput(`
      // нет. Регулярка жадная: `\w+` иначе отдаёт хвосту лишь последнюю букву.
      const family = /^(\w+)(Open|Output|Write|Stop|List)$/.exec(name);
      const record = family ? new RegExp(`(?:^|[ ,:])${family[1]}\\(([^)]*)\\)`).exec(note) : null;
      const inFamily =
        family !== null && record !== null && record[1]!.split(/[|,]/).includes(name.slice(family[1]!.length));
      const shown = note.includes(`${name}(`) ? `${name}(` : inFamily ? `${family![1]}(` : null;
      expect(shown, `в ростере нет формы ${name}`).not.toBeNull();
      expect(toolPresetAllows('auto', name), `${name} не должен входить в схемы`).toBe(false);
      // Полный набор не задет: исключение — про цену, а не про возможность.
      expect(toolPresetAllows('full', name)).toBe(true);
      expect(
        AGENT_TOOLS.some((tool) => tool.name === name),
        `${name} нет в описании инструментов`,
      ).toBe(true);
    }
  });

  it('семья терминала едет одной записью, но говорит про обязательные id и data', () => {
    // Шесть имён подряд стоили 84 токена на каждом шаге и несли одно знание:
    // «у терминала есть сессия, вывод, ввод, стоп, список». Свёрнуто в
    // `terminal(Open|Output|…, command, cwd?, id, data)`.
    const note = toolPresetNote('auto');
    expect(note).toContain('terminal(Open|Output|Write|Stop|List');
    // `terminalWrite` без `id` и `data` откажет на первом же вызове, а схемы в
    // наборе нет — эти поля обязаны быть в строке. `cwd?` — как был, с `?`.
    expect(note).toContain('cwd?');
    expect(note).toContain('id');
    expect(note).toContain('data');
    // Сворачиваем только то, что правда в ростере целиком: обрезанная семья
    // обещала бы имена, которых в наборе нет (`terminalList` при выключенном
    // терминале).
    const onlyOutput = rosterLine(['terminalOutput']);
    expect(onlyOutput).toContain('terminalOutput(');
    expect(onlyOutput).not.toContain('terminal(');
  });

  it('инструмент ростера не расширяет набор после вызова', () => {
    // Схема, добавленная в набор один раз, едет в каждом следующем запросе
    // прогона (terminal — 344 токена на шаг) и меняет префикс, который кэширует
    // провайдер. Поэтому вызов по имени выполняет инструмент, но набор не растёт.
    for (const name of toolPresetSpec('auto').except ?? []) {
      expect(isRosterTool('auto', name), `${name} должен считаться ростором`).toBe(true);
    }
    expect(isRosterTool('auto', 'read_file')).toBe(false);
    // Ростер есть у любого набора: вопрос не в правах, а в том, что едет схемой.
    // В узком наборе он ограничен его группами — `terminal` это команды, не чтение.
    expect(isRosterTool('read', 'checks')).toBe(true);
    expect(isRosterTool('read', 'terminal')).toBe(false);
    // `show` — 189 токенов схемой в каждом запросе, а строка ростера (40 т.)
    // называет то же самое: action с его значениями. Схема едет только когда она
    // и есть смысл роста — «расширение» набора по имени.
    expect(isRosterTool('auto', 'show')).toBe(true);
    expect(isRosterTool('edit', 'show')).toBe(true);
    // Разрешённым от этого он не быть перестал: вызов по имени проходит.
    expect(toolPresetAllows('read', 'checks')).toBe(true);
  });

  it('ростер обещает только то, что пройдёт', () => {
    // Строка говорит модели: «вызови по имени — выполнится». Значит, каждое имя
    // ростера в своём наборе обязано быть зовимым либо правом, либо расширением.
    for (const preset of TOOL_PRESETS) {
      for (const name of rosterNames(preset.id)) {
        // `mcp` в узких наборах снят `except`-ом нарочно (набор, обещавший «без
        // сети», не должен поднимать сервер), и в ростере его тоже нет — а если
        // попадёт, это не обещание вызова, а упоминание: одна модель не назовёт
        // то, о чём ей ни разу не сказали.
        if (name === 'mcp' && !toolPresetAllows(preset.id, name)) continue;
        const callable = preset.widen === true || toolPresetAllows(preset.id, name);
        expect(callable, `${name} спрятан, но в «${preset.label}» не зовётся`).toBe(true);
        // И оно есть в описании: опечатка в ростере стоила бы целого шага.
        expect(
          AGENT_TOOLS.some((tool) => tool.name === name),
          `${name} нет в AGENT_TOOLS`,
        ).toBe(true);
      }
    }
    // Ростер — цена, а не запрет: полный набор по-прежнему разрешает всё.
    expect(toolPresetAllows('full', 'mind')).toBe(true);
  });

  it('модели говорят о скрытом — и в полном наборе тоже', () => {
    // Полный набор больше не «всё схемами»: редкое и простое ушло в тот же ростер.
    // Разрешение осталось полным, но без слова об этом инструментов для модели нет.
    const full = toolPresetNote('full');
    expect(full).toContain('по имени');
    expect(full).toContain('lsp');

    for (const preset of TOOL_PRESETS) {
      if (preset.id === 'full') continue;
      const note = toolPresetNote(preset.id);
      expect(note).toContain(preset.label);
      if (preset.widen) expect(note).toContain('по имени');
      else expect(note).toContain('человеку');
    }
  });

  it('у каждого пресета есть подпись и подсказка', () => {
    for (const preset of TOOL_PRESETS) {
      expect(toolPresetSpec(preset.id)).toBe(preset);
      expect(preset.label.length).toBeGreaterThan(2);
      expect(preset.hint.length).toBeGreaterThan(10);
      expect(preset.icon.length).toBeGreaterThan(2);
    }
  });
});

describe('ростер не обещает запрещённого', () => {
  it('«Только чтение» не зовёт mcp ни строкой, ни по имени', () => {
    // `except` прячет от цены, `deny` — от модели: mcp поднял бы живой сервер,
    // которого набор чтения не обещал.
    expect(toolPresetAllows('read', 'mcp')).toBe(false);
    expect(rosterNames('read')).not.toContain('mcp');
    expect(toolPresetNote('read')).not.toContain('mcp(');
  });
});
