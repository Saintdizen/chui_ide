import { describe, expect, it } from 'vitest';
import { formatProjectMap, formatShortMap, projectTitle } from '../src/shared/project-map';
import { buildScan, type ProjectScan } from '../src/shared/project-scan';

/**
 * Карта проекта — то, чем агент узнаёт устройство проекта, не читая файлов.
 *
 * Проверяем обе формы: короткую (уходит в системный промпт на каждый запрос) и
 * подробную (ответ инструмента `project_map`). Главное здесь — чтобы карта
 * говорила о проекте правду и оставалась короткой: она собрана по именам файлов,
 * и содержимое в неё попасть не должно.
 */

const scanOf = (files: string[], dirCount = 3): ProjectScan =>
  buildScan({ root: '/p/demo', name: 'demo', files, dirCount });

const NODE = scanOf([
  'package.json',
  'README.md',
  'src/index.ts',
  'src/util.ts',
  'src/main/app.ts',
  'tests/util.test.ts',
  'tests/app.test.ts',
  'Makefile',
]);

describe('projectTitle', () => {
  it('вид проекта плюс манифест, по которому узнали', () => {
    expect(projectTitle(NODE)).toBe('Node.js (package.json)');
  });

  it('без манифеста — только вид', () => {
    expect(projectTitle(scanOf(['src/main.rs']))).toBe('Rust');
  });

  it('манифест, уже названный в виде проекта, не дублируется', () => {
    // «Python (pyproject)» + файл дало бы «Python (pyproject) (pyproject.toml)».
    expect(projectTitle(scanOf(['pyproject.toml', 'app/main.py']))).toBe('Python (pyproject)');
    expect(projectTitle(scanOf(['requirements.txt', 'app/main.py']))).toBe('Python (requirements)');
  });
});

describe('formatShortMap', () => {
  it('называет проект, файлы, языки, каталоги и тесты', () => {
    const map = formatShortMap(NODE);

    expect(map).toContain('Карта проекта');
    expect(map).toContain('Node.js (package.json) — 8 файлов в 3 каталогах');
    expect(map).toContain('Языки: TypeScript 5');
    expect(map).toContain('Каталоги: src, tests');
    expect(map).toContain('Тесты: 2 файла, каталоги tests');
    expect(map).toContain('Точки входа: src/index.ts');
  });

  it('содержимое файлов в карту не попадает', () => {
    // Карта собрана по именам: если в тексте появится что-то из файлов, значит
    // принцип «не читать файлы» нарушен.
    const map = formatShortMap(scanOf(['src/index.ts']));
    expect(map).not.toContain('console.log');
  });

  it('короткая: языки и манифесты целиком не перечисляет', () => {
    const map = formatShortMap(NODE);
    expect(map).not.toContain('Манифесты:');
    expect(map).not.toContain('Тесты, примеры:');
  });

  it('проект без тестов и точек входа говорит об этом, а не молчит', () => {
    const map = formatShortMap(scanOf(['README.md', 'data.json']));
    expect(map).toContain('Тесты: не найдены');
    expect(map).not.toContain('Точки входа');
    expect(map).toContain('Каталоги: —');
  });

  it('проект без кода не выдумывает язык', () => {
    const map = formatShortMap(scanOf(['LICENSE', 'notes.txt']));
    expect(map).toContain('Проект: Неизвестно');
    expect(map).toContain('Языки: нет распознанных файлов');
  });

  it('число файлов согласовано с существительным', () => {
    const line = (files: string[]): string => formatShortMap(scanOf(files, 1)).split('\n')[1] ?? '';

    expect(line(['src/a.ts'])).toContain('1 файл ');
    expect(line(['src/a.ts', 'src/b.ts'])).toContain('2 файла ');
    expect(line(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'])).toContain('5 файлов ');
    expect(line(Array.from({ length: 11 }, (_, index) => `src/f${index}.ts`))).toContain('11 файлов ');
  });

  it('длинные списки обрезаны числом, а не молча', () => {
    const files = Array.from({ length: 30 }, (_, index) => `dir${String(index).padStart(2, '0')}/x.ts`);
    const map = formatShortMap(scanOf(files));
    expect(map).toContain('ещё 16');
  });
});

describe('formatProjectMap', () => {
  it('подробная форма добавляет манифесты и примеры тестов', () => {
    const map = formatProjectMap(NODE);

    expect(map.detail).toContain('Манифесты: package.json, Makefile');
    expect(map.detail).toContain('Тесты, примеры: tests/util.test.ts, tests/app.test.ts');
  });

  it('подсказывает, куда смотреть дальше', () => {
    const map = formatProjectMap(NODE);

    expect(map.detail).toContain('find_files');
    expect(map.detail).toContain('codebase_search');
    expect(map.detail).toContain('startLine');
  });

  it('сводка — то, что видно в карточке инструмента', () => {
    expect(formatProjectMap(NODE).summary).toBe('Node.js · 8 файлов в 3 каталогах, тестов 2');
  });

  it('число каталогов согласовано: «в 1 каталоге», «в 3 каталогах»', () => {
    const one = scanOf(['package.json', 'src/index.ts', 'src/util.ts'], 1);

    expect(formatProjectMap(one).summary).toBe('Node.js · 3 файла в 1 каталоге');
    expect(formatShortMap(one)).toContain('в 1 каталоге');
  });

  it('примеры тестов не повторяют друг друга и не уходят за предел', () => {
    const files = Array.from({ length: 12 }, (_, index) => `tests/test_${index}.ts`);
    const map = formatProjectMap(scanOf(files));
    expect(map.detail).toContain('Тесты, примеры: tests/test_0.ts');
    expect(map.detail).toContain('ещё 7');
  });
});
