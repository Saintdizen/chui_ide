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
  // Ростер вычтён — так же, как его вычитает service перед отправкой: иначе отчёт
  // показывал бы цену схем, которых в запросе нет.
  const allowed = presetToolNames(preset);
  const tools = AGENT_TOOLS.filter(
    (tool) => (allowed === null || allowed.has(tool.name)) && !isRosterTool(preset, tool.name),
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

  // Замер: auto был 3 812 ток. (25 схем). Срезали ростром шести имён на 826 и
  // описаниями — до того, что не сказано в промпте. Сейчас 2 620.
  it('набор по умолчанию не дороже 2 700 токенов', () => {
    expect(presetTokens('auto')).toBeLessThan(2_700);
  });

  it('ростер не растёт в цене схем', () => {
    // Ростер — второй способ отдать инструмент: имя и обязательные аргументы по
    // 8,8 ток. вместо 74-427 за схему. Но он тоже едет в каждом запросе, поэтому
    // потолок нужен и здесь: иначе соблазн «спрятать всё» превратит набор в
    // список имён без единой схемы, и модели придётся угадывать вызовы.
    const note = estimateTextTokens(toolPresetNote('auto'));
    expect(note).toBeLessThan(300);
    // И обратная сторона: набор не должен схлопнуться до десятка имён. 15 из 49 —
    // граница, за которой модель начнёт угадывать вызовы вместо работы.
    expect(presetToolNames('auto')?.size ?? 0).toBeGreaterThan(15);
  });

  it('набор по умолчанию дешевле полного хотя бы на пятую часть', () => {
    const full = presetTokens('full');
    const preset = TOOL_PRESETS[0]!;
    expect(presetTokens(preset.id)).toBeLessThan(full * 0.85);
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
      ['подзадачи', ['task', 'workflow']],
      ['поиск', ['search', 'codebase_search', 'search_docs']],
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
    expect(rows.length).toBeGreaterThan(40);
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
    // Промпт — текст, а не механика: он не должен весить больше части схем.
    for (const preset of TOOL_PRESETS) {
      expect(estimateTextTokens(agentPrompt(preset.id, { confirm: true }))).toBeLessThan(presetTokens(preset.id));
      // Ростер — цена скрытого: строка с именами не может стоить как схемы, которые прячет.
      expect(estimateTextTokens(toolPresetNote(preset.id))).toBeLessThan(300);
    }
  });
});
