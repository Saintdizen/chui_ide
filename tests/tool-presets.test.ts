import { describe, expect, it } from 'vitest';
import { estimateTextTokens } from '../src/shared/context-fit';
import { AGENT_TOOLS, toOpenAiTools } from '../src/shared/tools';
import {
  DEFAULT_TOOL_PRESET,
  TOOL_GROUPS,
  TOOL_PRESETS,
  presetToolNames,
  sanitizeToolPreset,
  toolPresetAllows,
  toolPresetNote,
  toolPresetSpec,
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

/** Вес схем набора — так же, как его считает service при отправке модели. */
function presetTokens(preset: ToolPresetId): number {
  const allowed = presetToolNames(preset);
  const tools = allowed === null ? AGENT_TOOLS : AGENT_TOOLS.filter((tool) => allowed.has(tool.name));
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
    const mutating = [
      'apply_edit',
      'apply_patch',
      'create_file',
      'delete_file',
      'move_file',
      'replace_in_files',
      'run_terminal',
      'terminal',
      'git_commit',
      'git_push',
      'git_checkout',
      'browser',
      'schedule',
      'run_code',
    ];
    for (const name of mutating) {
      expect(allowed.has(name), `«чтение» не должно предлагать ${name}`).toBe(false);
    }
    // А читать и спрашивать — обязано: иначе набор бесполезен.
    for (const name of ['read_file', 'search', 'file_outline', 'ask']) {
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
    expect(toolPresetAllows('full', 'git_push')).toBe(true);
    // Чужое имя (внешний инструмент MCP) полный набор тоже пропускает: судить о
    // нём по нашему списку нельзя, решает это `canRun` и настройки MCP.
    expect(toolPresetAllows('full', 'mcp_что_то')).toBe(true);
    expect(toolPresetAllows('read', 'mcp_что_то')).toBe(false);
  });

  it('узкие наборы заметно дешевле полного', () => {
    expect(tokens.read).toBeLessThan(tokens.full * 0.6);
    expect(tokens.minimal).toBeLessThan(tokens.read * 0.6);
    expect(tokens.edit).toBeLessThan(tokens.full);
    // Абсолютный потолок чтения: ради этого выбор и заводился (замер — ≈4 600).
    expect(tokens.read).toBeLessThan(6_500);
  });

  it('полный набор не толстеет незаметно', () => {
    // Каждая лишняя фраза в описании аргумента платится в каждом запросе: замер
    // на проводе — 9 204 токена. Сторож держит потолок с запасом в 1%: обычная
    // правка пройдёт, а возврат «объясню подробнее» на десяток описаний — нет.
    expect(tokens.full).toBeLessThan(9_400);
  });

  it('неизвестное значение набора считается полным', () => {
    expect(sanitizeToolPreset('read')).toBe('read');
    expect(sanitizeToolPreset(undefined)).toBe(DEFAULT_TOOL_PRESET);
    expect(sanitizeToolPreset('nonsense')).toBe('full');
  });

  it('модели говорят о сужении, а о полном наборе — нет', () => {
    expect(toolPresetNote('full')).toBe('');
    for (const preset of TOOL_PRESETS) {
      if (preset.id === 'full') continue;
      const note = toolPresetNote(preset.id);
      expect(note).toContain(preset.label);
      // Совет конкретный: сказать человеку, а не искать обходной путь.
      expect(note).toContain('человеку');
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
