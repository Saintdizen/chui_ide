import { describe, expect, it } from 'vitest';
import { fileGroupOf, groupByKind, groupLabel } from '../src/renderer/core/tree-group';

describe('fileGroupOf: роль файла по имени', () => {
  it('тесты узнаются по маркеру перед расширением', () => {
    expect(fileGroupOf('button.test.ts')).toBe('test');
    expect(fileGroupOf('button.spec.tsx')).toBe('test');
    expect(fileGroupOf('Button.Tests.js')).toBe('test');
  });

  it('тесты узнаются по приставке и хвосту (pytest)', () => {
    expect(fileGroupOf('test_button.py')).toBe('test');
    expect(fileGroupOf('button_test.py')).toBe('test');
    expect(fileGroupOf('conftest.py')).toBe('test');
  });

  it('«contest» — не тест: точка перед маркером обязательна', () => {
    expect(fileGroupOf('contest.ts')).toBe('source');
    expect(fileGroupOf('latest.py')).toBe('source');
  });

  it('стили — по расширению', () => {
    expect(fileGroupOf('button.module.css')).toBe('style');
    expect(fileGroupOf('theme.scss')).toBe('style');
    expect(fileGroupOf('vars.less')).toBe('style');
  });

  it('документация — markdown, rst, txt', () => {
    expect(fileGroupOf('README.md')).toBe('doc');
    expect(fileGroupOf('notes.txt')).toBe('doc');
    expect(fileGroupOf('manual.rst')).toBe('doc');
  });

  it('конфигурация — по расширению и по имени', () => {
    expect(fileGroupOf('package.json')).toBe('config');
    expect(fileGroupOf('tsconfig.json')).toBe('config');
    expect(fileGroupOf('docker-compose.yml')).toBe('config');
    expect(fileGroupOf('Makefile')).toBe('config');
    expect(fileGroupOf('Dockerfile')).toBe('config');
  });

  it('ресурсы — картинки, шрифты, медиа', () => {
    expect(fileGroupOf('logo.svg')).toBe('assets');
    expect(fileGroupOf('icon.png')).toBe('assets');
    expect(fileGroupOf('font.woff2')).toBe('assets');
  });

  it('код без особых примет — исходники', () => {
    expect(fileGroupOf('button.tsx')).toBe('source');
    expect(fileGroupOf('main.py')).toBe('source');
    expect(fileGroupOf('index.html')).toBe('source');
    expect(fileGroupOf('lib.rs')).toBe('source');
  });

  it('тест идёт раньше стиля: `button.test.css` — тест', () => {
    expect(fileGroupOf('button.test.css')).toBe('test');
  });
});

describe('groupLabel: подписи полок', () => {
  it('у каждой роли есть читаемое имя', () => {
    expect(groupLabel('test')).toBe('Тесты');
    expect(groupLabel('source')).toBe('Исходники');
  });
});

describe('groupByKind: раскладка по полкам', () => {
  const names = ['button.tsx', 'button.test.tsx', 'button.module.css', 'README.md', 'package.json', 'logo.svg'];
  const nameOf = (item: string): string => item;

  it('собирает файлы одного назначения вместе в порядке полок', () => {
    const groups = groupByKind(names, nameOf);
    expect(groups.map((group) => group.id)).toEqual(['test', 'style', 'doc', 'config', 'assets', 'source']);
    expect(groups.map((group) => group.entries)).toEqual([
      ['button.test.tsx'],
      ['button.module.css'],
      ['README.md'],
      ['package.json'],
      ['logo.svg'],
      ['button.tsx'],
    ]);
  });

  it('порядок внутри полки — исходный (его задала сортировка дерева)', () => {
    const groups = groupByKind(['b.ts', 'a.ts', 'c.ts'], nameOf);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.entries).toEqual(['b.ts', 'a.ts', 'c.ts']);
  });

  it('пустых полок не возвращает', () => {
    const groups = groupByKind(['main.py'], nameOf);
    expect(groups.map((group) => group.id)).toEqual(['source']);
  });

  it('пустой список — пустой результат', () => {
    expect(groupByKind([], nameOf)).toEqual([]);
  });
});
