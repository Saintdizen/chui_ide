import { describe, expect, it } from 'vitest';
import { folderFromCommandLine } from '../src/shared/cli';

/**
 * Папка из командной строки. Проверяем прежде всего то, что папкой проекта НЕ
 * является: переключатели Electron и путь самого приложения — их легко принять
 * за проект, и тогда IDE открывала бы себя вместо нужного каталога.
 */
const run = (args: string[], over: { dirs?: string[]; ignore?: string[] } = {}) => {
  const dirs = new Set(over.dirs ?? []);
  return folderFromCommandLine({
    args,
    resolve: (value) => (value.startsWith('/') ? value : `/cwd/${value.replace(/^\.\//, '')}`),
    ignore: over.ignore,
    isDirectory: (candidate) => dirs.has(candidate),
  });
};

/** Только найденная папка: в большинстве случаев интересна она, а не отказы. */
const input = (args: string[], over: { dirs?: string[]; ignore?: string[] } = {}) => run(args, over).folder;

describe('folderFromCommandLine', () => {
  it('находит папку среди аргументов', () => {
    expect(input(['/home/user/api'], { dirs: ['/home/user/api'] })).toBe('/home/user/api');
  });

  it('переключатели Electron пропускает', () => {
    // Так выглядит запуск упакованного приложения: сначала идут свои флаги.
    expect(input(['--no-sandbox', '--user-data-dir=/tmp/x', '/home/user/api'], { dirs: ['/home/user/api'] })).toBe(
      '/home/user/api',
    );
  });

  it('путь самого приложения папкой проекта не считается', () => {
    // `electron .` в разработке: '.' — это приложение, а не открываемый проект.
    expect(input(['.', '/home/user/api'], { dirs: ['/cwd', '/home/user/api'], ignore: ['/cwd'] })).toBe(
      '/home/user/api',
    );
  });

  it('если кроме приложения ничего нет — папки нет', () => {
    expect(input(['.'], { dirs: ['/cwd'], ignore: ['/cwd'] })).toBeNull();
  });

  it('несуществующий путь пропускается, а не возвращается', () => {
    expect(input(['/нет/такого', '/home/user/api'], { dirs: ['/home/user/api'] })).toBe('/home/user/api');
    expect(input(['/нет/такого'], { dirs: [] })).toBeNull();
  });

  it('файл вместо папки не открывается', () => {
    // `isDirectory` для файла вернёт false — проверка на стороне вызывающего.
    expect(input(['/home/user/app.py', '/home/user'], { dirs: ['/home/user'] })).toBe('/home/user');
  });

  it('относительный путь разрешается через рабочий каталог', () => {
    expect(input(['./api'], { dirs: ['/cwd/api'] })).toBe('/cwd/api');
  });

  it('пустые аргументы и разделитель `--` пропускаются', () => {
    expect(input(['', '   ', '--', '/home/user/api'], { dirs: ['/home/user/api'] })).toBe('/home/user/api');
  });

  it('хвостовой слэш не мешает сравнению с путём приложения', () => {
    expect(input(['/cwd/'], { dirs: ['/cwd'], ignore: ['/cwd'] })).toBeNull();
  });

  it('аргументов нет — папки нет', () => {
    expect(input([], { dirs: ['/home/user/api'] })).toBeNull();
  });

  it('недоступный путь назван, а не проглочен', () => {
    // Опечатка в пути не должна выглядеть как «приложение просто не открыло папку»:
    // аргумент похож на путь — значит, о неудаче надо сказать.
    const result = run(['/home/user/оепчатка', '/home/user/api'], { dirs: ['/home/user/api'] });

    expect(result.folder).toBe('/home/user/api');
    expect(result.unusable).toEqual(['/home/user/оепчатка']);
  });

  it('переключатели и путь приложения отказом не считаются', () => {
    const result = run(['--no-sandbox', '.'], { dirs: ['/cwd'], ignore: ['/cwd'] });

    expect(result.folder).toBeNull();
    expect(result.unusable).toEqual([]);
  });
});
