import { describe, expect, it } from 'vitest';
import { actionImpact } from '../src/shared/code-action-impact';

describe('actionImpact: что будет сделано до выбора', () => {
  it('без правок писать нечего: там только команда сервера', () => {
    expect(actionImpact(null, '/p/a.ts').label).toBe('');
    expect(actionImpact([], '/p/a.ts').label).toBe('');
  });

  it('правка в одном месте одного файла говорит про место', () => {
    const label = actionImpact(
      [{ path: '/p/a.ts', edits: [{ startLine: 1, startColumn: 0, endLine: 1, endColumn: 5, newText: '' }] }],
      '/p/a.ts',
    ).label;
    // Файл тот же — его не называем: «в этом файле» короче и точнее имени.
    expect(label).toContain('в этом файле');
    expect(label).toContain('1 место');
  });

  it('несколько мест и файлов считаются', () => {
    const edit = (path: string, n: number) => ({
      path,
      edits: Array.from({ length: n }, (_, i) => ({
        startLine: i,
        startColumn: 0,
        endLine: i,
        endColumn: 2,
        newText: 'x',
      })),
    });
    const impact = actionImpact([edit('/p/a.ts', 3), edit('/p/b.ts', 9)], '/p/a.ts');
    expect(impact.files).toBe(2);
    expect(impact.edits).toBe(12);
    expect(impact.elsewhere).toBe(true);
    expect(impact.label).toContain('12 мест');
  });

  it('правка только в других файлах — это не «здесь»', () => {
    const impact = actionImpact(
      [{ path: '/p/b.ts', edits: [{ startLine: 0, startColumn: 0, endLine: 0, endColumn: 1, newText: '' }] }],
      '/p/a.ts',
    );
    expect(impact.elsewhere).toBe(true);
    expect(impact.inThisFile).toBe(0);
  });

  it('свои файлы не считаются чужими', () => {
    const impact = actionImpact(
      [{ path: '/p/a.ts', edits: [{ startLine: 0, startColumn: 0, endLine: 0, endColumn: 1, newText: '' }] }],
      '/p/a.ts',
    );
    expect(impact.elsewhere).toBe(false);
    expect(impact.inThisFile).toBe(1);
  });

  it('склонение по числу: 1 файл, 2 файла, 5 файлов', () => {
    const one = (n: number) =>
      actionImpact(
        Array.from({ length: n }, (_, i) => ({
          path: `/p/${i}.ts`,
          edits: [{ startLine: 0, startColumn: 0, endLine: 0, endColumn: 1, newText: '' }],
        })),
        '/p/x.ts',
      ).label;
    expect(one(1)).toContain('1 файл');
    expect(one(2)).toContain('2 файла');
    expect(one(5)).toContain('5 файлов');
  });
});
