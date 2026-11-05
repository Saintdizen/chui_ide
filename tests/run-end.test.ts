import { describe, expect, it } from 'vitest';
import { runEndReport } from '../src/renderer/ui/run-end';

describe('чем кончился прогон', () => {
  it('прерванный вручную называет себя остановленным, а не ошибкой', () => {
    const report = runEndReport({ how: 'stopped', unsaved: [], files: [], artifacts: [] });
    expect(report.title).toBe('Прогон остановлен');
    expect(report.detail).toContain('вручную');
  });

  it('у падения показывает причину, если её сообщили', () => {
    const report = runEndReport({
      how: 'failed',
      reason: ' 429: Too Many Requests ',
      unsaved: [],
      files: [],
      artifacts: [],
    });
    expect(report.title).toBe('Прогон прерван ошибкой');
    expect(report.detail).toBe('429: Too Many Requests');
  });

  it('без причины честно говорит, что причина неизвестна', () => {
    // Молчание на месте причины читается как «зависло»: пустой detail хуже.
    const report = runEndReport({ how: 'failed', unsaved: [], files: [], artifacts: [] });
    expect(report.detail).toContain('неизвестна');
  });

  it('пустой reason из одних пробелов — тоже причина неизвестна', () => {
    const report = runEndReport({
      how: 'failed',
      reason: '   ',
      unsaved: [],
      files: [],
      artifacts: [],
    });
    expect(report.detail).toContain('неизвестна');
  });

  it('несохранённое стоит первым: оно пропадёт при закрытии окна', () => {
    const report = runEndReport({
      how: 'failed',
      unsaved: ['src/a.ts', 'src/b.ts'],
      files: [{ path: 'src/c.ts', kind: 'created' }],
      artifacts: [],
    });
    expect(report.facts[0]).toContain('Не сохранено 2 файла');
    expect(report.facts[0]).toContain('src/a.ts');
    expect(report.facts[1]).toContain('создан файл');
  });

  it('роды изменений не складываются в одно «изменено файлов»', () => {
    const report = runEndReport({
      how: 'stopped',
      unsaved: [],
      files: [
        { path: 'a.ts', kind: 'created' },
        { path: 'b.ts', kind: 'modified' },
        { path: 'c.ts', kind: 'deleted' },
      ],
      artifacts: [],
    });
    const text = report.facts.join('\n');
    expect(text).toContain('создан файл: a.ts');
    expect(text).toContain('изменён файл: b.ts');
    expect(text).toContain('удалён файл: c.ts');
    // Порядок родов задан, а не выходит случайно: что появилось, важнее, чем что
    // изменилось, а удалённое читают последним. Без этого теста перестановка
    // `kinds` проходила мимо, и сводка становилась непредсказуемой.
    expect(report.facts.map((fact) => fact.split(' ')[0])).toEqual(['создан', 'изменён', 'удалён']);
  });

  it('много файлов одного рода — числом и коротким перечнем', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ path: `f${i}.ts`, kind: 'modified' as const }));
    const report = runEndReport({ how: 'failed', unsaved: [], files: many, artifacts: [] });
    const line = report.facts.join('\n');
    expect(line).toContain('изменено файлов: 12');
    // Восемь имён и остаток числом: длинный перечень — уже не сводка.
    expect(line).toContain('и ещё 4');
    expect(line).not.toContain('f11.ts');
  });

  it('ничего не сделано — hasWork ложь, и это не то же, что пустые факты при работе', () => {
    const report = runEndReport({ how: 'failed', unsaved: [], files: [], artifacts: [] });
    expect(report.hasWork).toBe(false);
    expect(report.facts).toEqual([]);
  });

  it('одна заметка — «заметка», а не «заметок»', () => {
    const report = runEndReport({
      how: 'stopped',
      unsaved: [],
      files: [],
      artifacts: ['plan.md'],
    });
    expect(report.facts[0]).toBe('Сохранено 1 заметка: plan.md');
    expect(report.hasWork).toBe(true);
  });
});
