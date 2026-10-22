import { describe, expect, it } from 'vitest';
import { agentPrompt } from '../src/shared/agent-prompt';
import { formatThousands } from '../src/shared/run-log';
import { estimateTextTokens } from '../src/shared/context-fit';
import { AGENT_TOOLS, toOpenAiTools } from '../src/shared/tools';
import {
  ROSTER_TOOLS,
  TOOL_GROUPS,
  TOOL_PRESETS,
  isRosterTool,
  rosterNames,
  WIDENED_TOOLS,
  presetToolNames,
  toolPresetNote,
  type ToolPresetId,
} from '../src/shared/tool-presets';

/**
 * Бюджет схем инструментов — с отчётом, а не только с порогом.
 *
 * Схемы едут в КАЖДОМ запросе прогона, поэтому их вес — прямая цена шага. Сторож
 * держит три числа: отдельный инструмент не раздувается, описания аргументов не
 * возвращаются к «объясню подробнее», а наборы не толстеют незаметно. Суммы по
 * наборам считает `tool-presets.test.ts`; здесь — разбивка по инструментам, по
 * которой видно, куда уходит вес.
 */
function schemaTokens(spec: (typeof AGENT_TOOLS)[number]): number {
  return estimateTextTokens(JSON.stringify(toOpenAiTools([spec])));
}

function argumentDescriptionTokens(spec: (typeof AGENT_TOOLS)[number]): number {
  const parts: string[] = [];
  const walk = (properties: Record<string, { description?: string; items?: unknown; properties?: unknown }>): void => {
    for (const value of Object.values(properties)) {
      if (typeof value.description === 'string') parts.push(value.description);
      if (value.properties && typeof value.properties === 'object') walk(value.properties as never);
      if (value.items && typeof value.items === 'object') walk({ item: value.items as never });
    }
  };
  walk(spec.inputSchema.properties as never);
  return estimateTextTokens(parts.join(''));
}

const rows = AGENT_TOOLS.map((tool) => ({
  name: tool.name,
  tokens: schemaTokens(tool),
  args: argumentDescriptionTokens(tool),
})).sort((left, right) => right.tokens - left.tokens);

function presetTokens(preset: ToolPresetId): number {
  // Вычтено то же, что вычитает service перед отправкой: ростер (имя едет
  // строкой) и `WIDENED_TOOLS` (имени не видно вовсе, схема докачивается при
  // первом вызове). Иначе отчёт показывал бы цену схем, которых в запросе нет.
  const allowed = presetToolNames(preset);
  const tools = AGENT_TOOLS.filter(
    (tool) =>
      (allowed === null || allowed.has(tool.name)) &&
      !isRosterTool(preset, tool.name) &&
      !WIDENED_TOOLS.includes(tool.name),
  );
  return estimateTextTokens(JSON.stringify(toOpenAiTools(tools)));
}

describe('бюджет схем', () => {
  it('ни один инструмент не дороже 500 токенов', () => {
    const heavy = rows.filter((row) => row.tokens > 500);
    expect(heavy).toEqual([]);
  });

  it('описания аргументов вместе влезают в 1 800 токенов', () => {
    const total = rows.reduce((sum, row) => sum + row.args, 0);
    expect(total).toBeLessThan(1_800);
  });

  // Замер: auto был 3 812 ток. (25 схем). Срезали ростром имён на 826 и описаниями —
  // до того, что не сказано в промпте. `show` и `exit_plan_mode` (300 ток. вдвоём)
  // ушли в ростер, а `terminal`/`mcp` сначала прятались совсем — до п.45, когда
  // стало ясно, что докачка схемы обнуляет кеш префикса и дороже строки.
  it('операции с файлом живут в схеме edit, а не отдельной', () => {
    // `file` нет в схемах вовсе: его имя и форма едут строкой ростера (п.45).
    // Дубли сняты: `create`/`move`/`delete` есть у `file`, и в `edit` их больше
    // не объявляем — один смысл в двух схемах был источником промахов. Старые
    // вызовы `edit` с `action` при этом живы: `editAction` делегирует в `file`.
    const edit = AGENT_TOOLS.find((tool) => tool.name === 'edit')!;
    expect(edit.inputSchema.properties.action).toBeUndefined();
    expect(Object.keys(edit.inputSchema.properties)).not.toContain('replacement');
    const file = AGENT_TOOLS.find((tool) => tool.name === 'file')!;
    expect((file.inputSchema.properties.action as { enum?: string[] }).enum).toEqual([
      'create',
      'move',
      'delete',
      'replace',
    ]);
    expect(WIDENED_TOOLS).not.toContain('file');
    expect(ROSTER_TOOLS).toContain('file');
  });

  // Было 3 812 (25 схем) → 1 303 (7 схем) → 789 (3 схемы) → 567 (3 схемы, 08.2026:
  // `edit` без дубля формы 267→151, `search` с флагами строкой 227→199).
  // С ростром (281) и промптом (533) постоянная часть шага — 848.
  it('набор по умолчанию не дороже 900 токенов', () => {
    expect(presetTokens('auto')).toBeLessThan(900);
  });

  it('ростер не растёт в цене схем', () => {
    // Ростер — второй способ отдать инструмент: имя и обязательные аргументы по
    // 8,8 ток. вместо 74-427 за схему. Но он тоже едет в каждом запросе, поэтому
    // потолок нужен и здесь: иначе соблазн «спрятать всё» превратит набор в
    // список имён без единой схемы, и модели придётся угадывать вызовы.
    const note = estimateTextTokens(toolPresetNote('auto'));
    // 15 имён вместе с полями формы — 281 ток. С п.45 в строку переехали
    // `terminal`, `mcp`, `file`, `list` и `run_tests`: их схемы стоили 1 000
    // токенов на каждом шаге, а докачка вместо строки обнуляла кеш префикса.
    // `mind` переехал в 08.2026: схема 410 ток на каждом шаге против трёх полей
    // (`text`, `question`, `steps`) в строке. Потолок поднят с 270 до 290.
    expect(note).toBeLessThan(290);
    // И обратная сторона: набор не должен схлопнуться до десятка имён. 15 из 49 —
    // граница, за которой модель начнёт угадывать вызовы вместо работы.
    // Считаем не схемы, а имена, которые модель знает: ростер даёт вызов без
    // схемы, и экономия не должна превращаться в «этого инструмента нет».
    const known = new Set([...(presetToolNames('auto') ?? []), ...rosterNames('auto')]);
    expect(known.size).toBeGreaterThan(15);
  });

  // Схемы «Авто» и «Все инструменты» различают `browser` и `web`, а ростер у
  // обоих общий: ждать здесь пятой части нельзя — экономия «Авто» уже
  // потрачена на ростер. Сторож держит другое: наборы не съехались по цене.
  it('набор по умолчанию не дороже полного', () => {
    const full = presetTokens('full');
    const preset = TOOL_PRESETS[0]!;
    expect(presetTokens(preset.id)).toBeLessThanOrEqual(full);
  });

  it('отчёт: вес по семействам и кандидаты на слияние', () => {
    const byName = new Map(rows.map((row) => [row.name, row.tokens]));
    const sum = (names: readonly string[]): number => names.reduce((total, name) => total + (byName.get(name) ?? 0), 0);

    const groups = TOOL_GROUPS.map((group) => {
      const items = group.names.filter((name) => byName.has(name));
      return `${group.id.padEnd(9)} ${String(sum(items)).padStart(5)} ток. / ${items.length} инструм.`;
    });

    // Семейства, которые TASKS.md предлагает слить. Второе число — сколько это
    // стоит СЕЙЧАС, а не сколько будет после слияния: главный урок шестого
    // захода в том, что слияние с полем `action` почти ничего не даёт — тела схем
    // остаются оба, а общий у них только каркас.
    const candidates: ReadonlyArray<readonly [string, readonly string[]]> = [
      ['агенты', ['agents']],
      ['подзадачи', ['task']],
      ['поиск', ['search']],
      ['чтение файла', ['read']],
      ['список файлов', ['list', 'project_map']],
    ];
    // Имена из ростера в сумму не идут: они уже едут строкой, и слияние двух
    // таких имён не сэкономит ни токена — только запутает. Считать надо то, что
    // реально лежит схемами.
    const hidden = new Set(ROSTER_TOOLS);
    const lines = candidates.map(([label, names]) => {
      const priced = names.filter((name) => !hidden.has(name));
      const mark = priced.length < names.length ? ` (в ростере: ${names.length - priced.length})` : '';
      return `${label.padEnd(14)} ${String(sum(priced)).padStart(5)} ток. / ${priced.length}${mark}`;
    });

    console.log(['по группам:', ...groups, '', 'кандидаты на слияние:', ...lines].join('\n'));
    expect(groups.length).toBeGreaterThan(5);
  });

  it('семейство поиска уже слито: одна схема, старые имена — псевдонимы', () => {
    // Решение Ш5. Четыре имени отличались первой строкой описания, тело схемы было
    // общее; в наборе остался один `search` с полем `action`, а `codebase_search`,
    // `search_docs`, `session_search`, `session_trace`, `find_files` и `list_dir`
    // разобраны в `tool-aliases.ts`. Живые прогоны зовут его же: `search` — 4
    // вызова, `codebase_search`/`search_docs`/`session_search` — ноль. Поэтому
    // обратно разводить нечего, а сторож не даёт именам вернуться в схемы и
    // раздуть префикс.
    const present = AGENT_TOOLS.map((tool) => tool.name);
    for (const old of ['codebase_search', 'search_docs', 'session_search', 'session_trace', 'find_files', 'list_dir']) {
      expect(present, old).not.toContain(old);
    }
    const search = rows.find((row) => row.name === 'search');
    expect(search).toBeDefined();
    expect(search!.tokens, 'слитое семейство дешевле четырёх схем (731) и заявленных 400').toBeLessThanOrEqual(300);
  });

  it('отчёт: постоянная часть на шаг, а не только на запрос', () => {
    // Схемы с промптом платятся на каждом шаге и лежат в кеше префикса, а выводы
    // инструментов растут с каждым шагом и кешу не поддаются. Поэтому решать,
    // где экономить, надо по обоим числам сразу: прогон в восемь шагов платит
    // оглавление восемь раз. Их и печатаем рядом.
    const steps = 8;
    const table = TOOL_PRESETS.map((preset) => {
      const fixed = presetTokens(preset.id) + estimateTextTokens(agentPrompt(preset.id, { confirm: true }));
      return `${preset.id.padEnd(8)} шаг ${String(fixed).padStart(5)} ток. · прогон в ${steps}: ${formatThousands(fixed * steps)}`;
    });
    console.log(`цена постоянной части (выходы инструментов — отдельно, их считает трасса):\n${table.join('\n')}`);
    for (const preset of TOOL_PRESETS) {
      // Оглавление не должно стоить как полпрогона само по себе.
      const fixed = presetTokens(preset.id) + estimateTextTokens(agentPrompt(preset.id, { confirm: true }));
      expect(fixed).toBeLessThan(7_000);
    }
  });

  it('отчёт: куда уходит вес схем', () => {
    console.log(
      rows.map((row) => `${row.name.padEnd(20)} ${String(row.tokens).padStart(5)} (аргументы ${row.args})`).join('\n'),
    );
    // Схемы печатаются целиком: отчёт не должен молча терять инструменты.
    expect(rows.length).toBe(AGENT_TOOLS.length);
  });

  it('отчёт: схемы, промпт и строка ростера по наборам', () => {
    const table = TOOL_PRESETS.map((preset) => {
      const ready = estimateTextTokens(agentPrompt(preset.id, { confirm: true }));
      const note = estimateTextTokens(toolPresetNote(preset.id));
      const schemas = presetTokens(preset.id);
      return `${preset.id.padEnd(8)} схемы ${String(schemas).padStart(5)} + промпт ${String(ready).padStart(
        4,
      )} + ростер ${String(note).padStart(3)} = ${schemas + ready + note}`;
    });
    console.log(table.join('\n'));
    // Промпт — текст, а не механика, и от набора не зависит: у него свой потолок.
    // Схемы с ним сравнивать нельзя — у дешёвых наборов они уже меньше промпта.
    // Потолок — по «Авто»: он и есть плата за шаг, которую мы держим под присмотром.
    expect(estimateTextTokens(agentPrompt('auto', { confirm: true }))).toBeLessThan(570);
    for (const preset of TOOL_PRESETS) {
      // Ростер — цена скрытого: строка с именами не может стоить как схемы, которые прячет.
      expect(estimateTextTokens(toolPresetNote(preset.id))).toBeLessThan(290);
    }
  });
});
