import { describe, expect, it } from 'vitest';
import { estimateTextTokens } from '../src/shared/context-fit';
import { AGENT_TOOLS, toOpenAiTools } from '../src/shared/tools';
import {
  DEFAULT_TOOL_PRESET,
  TOOL_GROUPS,
  TOOL_PRESETS,
  isRosterTool,
  presetToolNames,
  rosterNames,
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

/** Вес схем набора — так же, как его считает service при отправке модели: ростер вычтён. */
function presetTokens(preset: ToolPresetId): number {
  const allowed = presetToolNames(preset);
  const tools = AGENT_TOOLS.filter(
    (tool) => (allowed === null || allowed.has(tool.name)) && !isRosterTool(preset, tool.name),
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
    const mutating = [
      'edit',
      'create_file',
      'delete_file',
      'move_file',
      'replace_in_files',
      'terminal',
      'git_write',
      'browser',
    ];
    for (const name of mutating) {
      expect(allowed.has(name), `«чтение» не должно предлагать ${name}`).toBe(false);
    }
    // А читать и спрашивать — обязано: иначе набор бесполезен.
    for (const name of ['read', 'search', 'lsp', 'ask']) {
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
    expect(toolPresetAllows('full', 'git_write')).toBe(true);
    // Чужое имя (внешний инструмент MCP) полный набор тоже пропускает: судить о
    // нём по нашему списку нельзя, решает это `canRun` и настройки MCP.
    expect(toolPresetAllows('full', 'mcp_что_то')).toBe(true);
    expect(toolPresetAllows('read', 'mcp_что_то')).toBe(false);
  });

  it('узкие наборы заметно дешевле полного', () => {
    // Ростер сжал и полный набор: разрыв с «Только чтение» стал 0,74 вместо 0,54.
    // Порог 0,8 держит именно это — иначе сторож молча пропустит рост схем.
    // После слияний (read, list) «Чтение» стало дешевле, а «Минимум» — нет: его
    // цена в основе, и порог оставлен 0,75.
    expect(tokens.read).toBeLessThan(tokens.full * 0.8);
    expect(tokens.minimal).toBeLessThan(tokens.read * 0.75);
    expect(tokens.edit).toBeLessThan(tokens.full);
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
    for (const name of ['edit', 'read', 'run_tests']) {
      expect(presetToolNames('auto')?.has(name), `в «Авто» нет ${name}`).toBe(true);
    }
    // Спросить человека тоже можно, но строкой ростера: форма вызова у него
    // простая, а схема стоила 121 токен в каждом запросе.
    expect(rosterNames('auto')).toContain('ask');
    // А дорогое и редкое — спрятано: именно на нём и экономия.
    for (const name of ['terminal', 'browser', 'git_write']) {
      expect(presetToolNames('auto')?.has(name), `в «Авто» не должно быть ${name}`).toBe(false);
    }
    expect(tokens.auto).toBeLessThan(tokens.full);
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
      // Ростера мало: без формы вызова первый вызов уйдёт наугад, и сэкономленные
      // токены вернутся шагом переделки. Строка строится из самих схем; у `agents`
      // первое поле — `action` со значениями `enum`, поэтому сверяем начало формы.
      const required = AGENT_TOOLS.find((tool) => tool.name === name)?.inputSchema.required ?? [];
      const head = required.length === 0 ? `${name}()` : `${name}(${required[0]}`;
      expect(note, `в ростере нет формы ${name}`).toContain(head);
      expect(toolPresetAllows('auto', name), `${name} не должен входить в схемы`).toBe(false);
      // Полный набор не задет: исключение — про цену, а не про возможность.
      expect(toolPresetAllows('full', name)).toBe(true);
      expect(
        AGENT_TOOLS.some((tool) => tool.name === name),
        `${name} нет в описании инструментов`,
      ).toBe(true);
    }
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
    // В узком наборе он ограничен его группами — rename_symbol это правка, не чтение.
    expect(isRosterTool('read', 'checks')).toBe(true);
    expect(isRosterTool('read', 'rename_symbol')).toBe(false);
    // Разрешённым от этого он не быть перестал: вызов по имени проходит.
    expect(toolPresetAllows('read', 'checks')).toBe(true);
  });

  it('ростер обещает только то, что пройдёт', () => {
    // Строка говорит модели: «вызови по имени — выполнится». Значит, каждое имя
    // ростера в своём наборе обязано быть зовимым либо правом, либо расширением.
    for (const preset of TOOL_PRESETS) {
      for (const name of rosterNames(preset.id)) {
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
