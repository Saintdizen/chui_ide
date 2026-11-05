import { describe, expect, it } from 'vitest';
import {
  appliedInstruction,
  appliedInstructionsLines,
  describeBrokenLinks,
  findBrokenLinks,
  formatInstructionFile,
  instructionSignature,
  instructionsChanged,
} from '../src/shared/instructions';

/**
 * Правила проекта едут в КАЖДОМ запросе, поэтому у длинного файла есть выбор:
 * обрезать посреди фразы или показать голову и карту разделов. Второе дороже на
 * пару строк, но модель знает, что текст есть и где его взять, — сторож держит
 * именно это: короткий файл не трогается, длинный не режется без адреса.
 */

function longRules(): string {
  const parts = ['# Правила проекта', 'Ставь точку с запятой в конце строки.'];
  for (let index = 1; index <= 20; index += 1) {
    parts.push(`## Раздел ${index}: подробности`, `Правило ${index}. `.repeat(40));
  }
  return parts.join('\n');
}

describe('правила проекта в промпте', () => {
  it('короткий файл едет целиком', () => {
    const text = '# Правила\nНе ломай сборку.';
    expect(formatInstructionFile('AGENTS.md', text, 8000)).toBe(`Инструкции из AGENTS.md:\n${text}`);
  });

  it('длинный помечается и не обрывается посреди строки', () => {
    const text = longRules();
    const out = formatInstructionFile('AGENTS.md', text, 4000);
    expect(out.length).toBeLessThan(text.length);
    // Пометка честная: модель должна знать, что видит не всё.
    expect(out).toContain('правила длиннее');
    // Голова кончается границей строки, а не половиной правила.
    const head = out.slice(out.indexOf('\n') + 1, out.indexOf('\n… (правила длиннее'));
    expect(text.startsWith(head)).toBe(true);
    expect(head.endsWith('\n')).toBe(false);
  });

  it('в отброшенной части указывает разделы и чем их достать', () => {
    const out = formatInstructionFile('CLAUDE.md', longRules(), 3000);
    expect(out).toContain('разделы:');
    expect(out).toContain('## Раздел');
    // Адрес, а не «дальше интереснее»: по файлу можно искать и читать диапазоном.
    expect(out).toContain('read');
    expect(out).toContain('search');
  });

  it('файл без заголовков всё равно получает путь к остатку', () => {
    const text = 'Длинная строка правил без единого заголовка.\n'.repeat(200);
    const out = formatInstructionFile('.ai_rules', text, 2000);
    expect(out).toContain('без заголовков');
    expect(out).toContain('read');
  });

  it('карта разделов не разрастается бесконечно', () => {
    const text = longRules();
    const out = formatInstructionFile('AGENTS.md', text, 8000);
    const mapLine = out.slice(out.indexOf('разделы:'), out.indexOf('. Нужное'));
    expect(mapLine.length).toBeLessThan(2_500);
  });
});

/**
 * Ссылки в правилах проверяются по путям проекта: правило с мёртвым адресом человек
 * читает как действующее и идёт в пустоту, а модель получает тот же адрес в каждом
 * запросе. Предупреждение говорим прямо и сам текст правил не переписываем.
 */
const paths = { files: ['src/app.ts', 'docs/api.md', 'tests/helpers/dom.ts'], dirs: ['src', 'docs', 'tests'] };

describe('битые ссылки в правилах', () => {
  it('живые ссылки молчат', () => {
    expect(findBrokenLinks('Смотри `src/app.ts` и `docs/api.md`.', paths)).toEqual([]);
  });

  it('мёртвая ссылка находится', () => {
    expect(findBrokenLinks('Смотри `src/gone.ts`.', paths)).toEqual(['src/gone.ts']);
  });

  it('добавляет источник правды из пути теста', () => {
    expect(findBrokenLinks('Файл tests/helpers/nope.ts отсутствует.', paths)).toEqual(['tests/helpers/nope.ts']);
  });

  it('каталог в ссылке не считается битым', () => {
    expect(findBrokenLinks('Правила в docs/ лежат рядом.', paths)).toEqual([]);
  });

  it('одна и та же ссылка не повторяется', () => {
    expect(findBrokenLinks('gone.ts и снова gone.ts', paths)).toEqual(['gone.ts']);
  });

  it('слова и адреса не краснеют', () => {
    // Ложная тревога дороже пропуска: на ней люди перестают верить предупреждению.
    const text = 'Читай `read`, ходи на example.com, версия v1.2.3, шаблон {name}/{id}.ts';
    expect(findBrokenLinks(text, paths)).toEqual([]);
  });

  it('ссылка за пределы проекта не проверяется', () => {
    expect(findBrokenLinks('Лежит ../outside/file.ts там.', paths)).toEqual([]);
  });

  it('без списка путей молчим: пустой список — не «в проекте пусто»', () => {
    expect(findBrokenLinks('src/gone.ts', { files: [] })).toEqual([]);
  });

  it('предупреждение называет файл правил и сами ссылки', () => {
    const out = describeBrokenLinks('AGENTS.md', ['src/gone.ts']);
    expect(out).toContain('AGENTS.md');
    expect(out).toContain('src/gone.ts');
    // Модель должна знать, что выдумывать содержимое нельзя.
    expect(out).toContain('Не выдумывай');
  });

  it('битых нет — предупреждения нет', () => {
    expect(describeBrokenLinks('AGENTS.md', [])).toBe('');
  });
});

describe('что из правил ушло в контекст', () => {
  it('длинный файл — «показана голова» и размер по потолку', () => {
    const item = appliedInstruction('AGENTS.md', 'a'.repeat(5000), 1000);
    expect(item).toEqual({ name: 'AGENTS.md', chars: 1000, truncated: true });
    const lines = appliedInstructionsLines([item]);
    expect(lines[0]).toContain('AGENTS.md');
    expect(lines.join('\n')).toContain('показана голова: AGENTS.md');
  });

  it('короткий файл — без пометки и с размером файла', () => {
    const item = appliedInstruction('CHUI.md', 'кратко', 8000);
    expect(item).toEqual({ name: 'CHUI.md', chars: 6, truncated: false });
    expect(appliedInstructionsLines([item])).toEqual(['CHUI.md — 6 симв.']);
  });

  it('правил нет — говорим, какие файлы искали', () => {
    const lines = appliedInstructionsLines([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('AGENTS.md');
  });

  it('смена набора видна: первый раз, тот же набор, другой размер, пропажа', () => {
    const one = [appliedInstruction('AGENTS.md', 'x'.repeat(10), 8000)];
    expect(instructionsChanged(undefined, one)).toBe(true);
    expect(instructionsChanged(one, [appliedInstruction('AGENTS.md', 'x'.repeat(10), 8000)])).toBe(false);
    expect(instructionsChanged(one, [appliedInstruction('AGENTS.md', 'x'.repeat(20), 8000)])).toBe(true);
    expect(instructionsChanged(one, [])).toBe(true);
  });

  it('отпечаток различает файлы одного размера', () => {
    const a = instructionSignature([appliedInstruction('A.md', '12345', 8000)]);
    const b = instructionSignature([appliedInstruction('B.md', '12345', 8000)]);
    expect(a).not.toBe(b);
  });
});
