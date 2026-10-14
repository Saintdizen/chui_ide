import { describe, expect, it } from 'vitest';
import {
  emptyProfile,
  formatDuration,
  heatLevel,
  highlightedLines,
  hottestLines,
  parseLineProfile,
  profileSummary,
} from '../src/shared/line-profile';

/** Отчёт обёртки в том виде, в каком его пишет профилировщик. */
function report(files: Record<string, [number, number, number][]>, extra: object = {}): string {
  return JSON.stringify({ files, elapsedNs: 12_000_000, exitCode: 0, error: null, ...extra });
}

describe('parseLineProfile: разбор отчёта', () => {
  it('читает строки файла и сортирует их по номеру', () => {
    const profile = parseLineProfile(
      report({
        '/p/a.py': [
          [3, 1, 300],
          [1, 2, 100],
        ],
      }),
    );
    expect(profile.files[0]!.path).toBe('/p/a.py');
    expect(profile.files[0]!.lines.map((line) => line.line)).toEqual([1, 3]);
    expect(profile.files[0]!.timeNs).toBe(400);
  });

  it('проценты считаются от общего времени профиля', () => {
    const profile = parseLineProfile(
      report({
        '/p/a.py': [
          [1, 1, 750],
          [2, 1, 250],
        ],
      }),
    );
    expect(profile.timeNs).toBe(1000);
    expect(profile.files[0]!.lines[0]!.percent).toBeCloseTo(75);
    expect(profile.files[0]!.lines[1]!.percent).toBeCloseTo(25);
  });

  it('файлы идут от самых «дорогих» к остальным', () => {
    const profile = parseLineProfile(report({ '/p/small.py': [[1, 1, 10]], '/p/big.py': [[1, 1, 990]] }));
    expect(profile.files.map((file) => file.path)).toEqual(['/p/big.py', '/p/small.py']);
  });

  it('битые строки пропускаются, номера меньше единицы отбрасываются', () => {
    const profile = parseLineProfile(report({ '/p/a.py': [[0, 1, 5], [2, 1, 5], [1]] as never }));
    expect(profile.files[0]!.lines.map((line) => line.line)).toEqual([2]);
  });

  it('ошибка программы и код выхода переносятся в профиль', () => {
    const profile = parseLineProfile(report({ '/p/a.py': [[1, 1, 5]] }, { exitCode: 1, error: 'Traceback...' }));
    expect(profile.exitCode).toBe(1);
    expect(profile.error).toContain('Traceback');
  });

  it('битый JSON — пустой профиль с пояснением, а не исключение', () => {
    const profile = parseLineProfile('{ не json');
    expect(profile.files).toEqual([]);
    expect(profile.error).toBeTruthy();
  });

  it('пустой отчёт без строк — пустой профиль', () => {
    expect(parseLineProfile(report({})).files).toEqual([]);
  });

  it('отчёт остаётся с ошибкой программы, даже если строк нет', () => {
    const profile = parseLineProfile(report({}, { exitCode: 2, error: 'упало' }));
    expect(profile.error).toBe('упало');
    expect(profile.exitCode).toBe(2);
  });
});

describe('heatLevel: жар строки', () => {
  it('пороги отделяют горячее от просто тёплого', () => {
    expect(heatLevel(0.4)).toBe(0);
    expect(heatLevel(1)).toBe(1);
    expect(heatLevel(4.9)).toBe(1);
    expect(heatLevel(5)).toBe(2);
    expect(heatLevel(19.9)).toBe(2);
    expect(heatLevel(20)).toBe(3);
    expect(heatLevel(80)).toBe(3);
  });

  it('доли процента не подсвечиваются', () => {
    expect(heatLevel(0)).toBe(0);
  });
});

describe('выбор строк и сводка', () => {
  const profile = parseLineProfile(
    report({
      '/p/a.py': [
        [1, 1, 800],
        [2, 1, 100],
        [3, 5, 90],
        [4, 1, 10],
      ],
      '/p/b.py': [[1, 1, 1000]],
    }),
  );

  it('подсвечиваются только строки выше порога', () => {
    // 40% и 59% — горячие, 0.99% ниже порога «тёплой» строки: её не красим.
    const file = parseLineProfile(
      report({
        '/p/a.py': [
          [1, 1, 4000],
          [2, 1, 5900],
          [3, 1, 99],
        ],
      }),
    ).files[0]!;
    expect(highlightedLines(file).map((item) => item.line)).toEqual([1, 2]);
  });

  it('горячие строки идут по убыванию времени через все файлы', () => {
    const top = hottestLines(profile, 2);
    expect(top.map((item) => `${item.path.split('/').pop()}:${item.line.line}`)).toEqual(['b.py:1', 'a.py:1']);
  });

  it('предел списка уважается', () => {
    expect(hottestLines(profile, 0)).toEqual([]);
  });

  it('сводка называет время и число горячих строк', () => {
    const summary = profileSummary(profile);
    expect(summary).toContain('файлов: 2');
    expect(summary).toContain('горячих строк:');
  });

  it('пустой профиль честно говорит, что строк нет', () => {
    expect(profileSummary(emptyProfile())).toContain('Профиль пуст');
  });
});

describe('formatDuration', () => {
  it('выбирает единицу по величине', () => {
    expect(formatDuration(1_500_000_000)).toBe('1.50 с');
    expect(formatDuration(287_000_000)).toBe('287.0 мс');
    expect(formatDuration(1_400)).toBe('1.4 мкс');
    expect(formatDuration(500)).toBe('500 нс');
  });
});
