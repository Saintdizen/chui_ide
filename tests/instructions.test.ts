import { describe, expect, it } from 'vitest';
import { formatInstructionFile } from '../src/shared/instructions';

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
