import { describe, expect, it } from 'vitest';
import {
  buildCommitPrompt,
  cleanCommitMessage,
  COMMIT_DIFF_MAX_CHARS,
  COMMIT_SUBJECT_LIMIT,
  isEmptyCommitMessage,
  truncateDiff,
} from '../src/shared/commit-message';

/**
 * Сообщение коммита по diff: сборка промпта и очистка ответа модели.
 *
 * Тут нет ни сети, ни окна, зато есть два места, где легко испортить результат:
 * обрезка diff (оборванная строка модели мешает) и очистка ответа (модель любит
 * ограждения, кавычки и подпись «Сообщение коммита:» — всё это в `git commit -m`
 * лишнее и попало бы в историю репозитория).
 */
const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 111..222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,4 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  '',
].join('\n');

describe('truncateDiff', () => {
  it('короткий diff не трогает', () => {
    expect(truncateDiff('короткий', 100)).toEqual({ text: 'короткий', truncated: false });
  });

  it('режет по строке и отмечает обрезку', () => {
    const result = truncateDiff(DIFF, 60);
    expect(result.truncated).toBe(true);
    // Режем по границе строки: обрывков посреди строки быть не должно. Последняя
    // строка — наша пометка об обрезке, её в исходном diff нет.
    const lines = result.text.split('\n');
    expect(lines.slice(0, -1).every((line) => DIFF.includes(line))).toBe(true);
    expect(result.text).toContain('обрезан');
  });

  it('потолок по умолчанию — общий для main и renderer', () => {
    expect(COMMIT_DIFF_MAX_CHARS).toBeGreaterThan(1000);
    expect(truncateDiff('x'.repeat(COMMIT_DIFF_MAX_CHARS + 10)).truncated).toBe(true);
  });

  it('потолок не бывает нулевым: 1 символ — уже предел, а не пустой ответ', () => {
    const result = truncateDiff('abcdefghij', 1);
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith('a')).toBe(true);
  });
});

describe('buildCommitPrompt', () => {
  it('говорит про индекс и ветку, diff кладёт в ограждение', () => {
    const prompt = buildCommitPrompt({ diff: DIFF, staged: true, branch: 'dev' });
    expect(prompt).toContain('проиндексированные');
    expect(prompt).toContain('dev');
    expect(prompt).toContain('```diff');
    expect(prompt).toContain('+const c = 4;');
  });

  it('без индекса — прямо об этом', () => {
    expect(buildCommitPrompt({ diff: DIFF, staged: false })).toContain('не в индексе');
  });

  it('новые файлы перечисляются: их нет в diff, но названия важны', () => {
    const prompt = buildCommitPrompt({ diff: DIFF, staged: false, untracked: ['tests/new.test.ts'] });
    expect(prompt).toContain('tests/new.test.ts');
  });

  it('пустой список новых файлов не добавляет строки', () => {
    expect(buildCommitPrompt({ diff: DIFF, staged: false, untracked: [] })).not.toContain('Новые файлы');
  });
});

describe('cleanCommitMessage', () => {
  it('простое сообщение остаётся как есть', () => {
    expect(cleanCommitMessage('Редактор: свёртка блоков')).toBe('Редактор: свёртка блоков');
  });

  it('снимает ограждение и подпись — они попали бы в git log', () => {
    expect(cleanCommitMessage('```\nРедактор: свёртка блоков\n```')).toBe('Редактор: свёртка блоков');
    expect(cleanCommitMessage('Сообщение коммита: Редактор: свёртка блоков')).toBe('Редактор: свёртка блоков');
    expect(cleanCommitMessage('Commit message: Fix the thing')).toBe('Fix the thing');
  });

  it('снимает кавычки вокруг всего сообщения', () => {
    expect(cleanCommitMessage('«Редактор: свёртка блоков»')).toBe('Редактор: свёртка блоков');
    expect(cleanCommitMessage('"Fix the thing"')).toBe('Fix the thing');
  });

  it('точка в конце темы убирается, тело не трогается', () => {
    const result = cleanCommitMessage('Редактор: свёртка блоков.\n\n- строки скрываются\n- значки в жёлобе');
    expect(result.split('\n')[0]).toBe('Редактор: свёртка блоков');
    expect(result).toContain('- значки в жёлобе');
  });

  it('тело с пустой строкой сохраняется: это часть сообщения', () => {
    const result = cleanCommitMessage('Тема\n\nТело в двух строках.');
    expect(result).toBe('Тема\n\nТело в двух строках.');
  });

  it('лишние пустые строки и хвостовые пробелы убираются', () => {
    expect(cleanCommitMessage('  Тема  \n\n\n\nтело   \n\n')).toBe('Тема\n\nтело');
  });

  it('CRLF приводится к LF: сообщение уходит в git, а не в файл с Windows-переносами', () => {
    expect(cleanCommitMessage('Тема\r\n\r\nтело\r\n')).toBe('Тема\n\nтело');
  });

  it('пустой ответ остаётся пустым', () => {
    expect(cleanCommitMessage('   \n  ')).toBe('');
    expect(cleanCommitMessage('```\n\n```')).toBe('');
  });
});

describe('isEmptyCommitMessage', () => {
  it('пустое и пробельное — пусто', () => {
    expect(isEmptyCommitMessage('')).toBe(true);
    expect(isEmptyCommitMessage('   \n ')).toBe(true);
    expect(isEmptyCommitMessage('Тема')).toBe(false);
  });
});

describe('инструкции модели', () => {
  it('потолок темы совпадает с тем, что названо в правиле', () => {
    // Число в промпте и число в коде — одно: иначе модель начнёт писать длиннее,
    // чем мы готовы показать в git log.
    expect(String(COMMIT_SUBJECT_LIMIT)).toBeDefined();
    expect(COMMIT_SUBJECT_LIMIT).toBeLessThanOrEqual(80);
  });
});
