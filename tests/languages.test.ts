import { describe, expect, it } from 'vitest';
import {
  basename,
  fileIconOf,
  languageFromPath,
  languageIndent,
  languageInfoForPath,
  languageLabel,
  PLAIN_LANGUAGE,
} from '../src/shared/languages';

describe('basename', () => {
  it('POSIX-путь', () => {
    expect(basename('/home/user/project/main.py')).toBe('main.py');
  });

  it('Windows-путь', () => {
    expect(basename('C:\\project\\src\\main.py')).toBe('main.py');
  });

  it('без разделителей возвращает как есть', () => {
    expect(basename('main.py')).toBe('main.py');
  });
});

describe('languageFromPath', () => {
  it('по расширению', () => {
    expect(languageFromPath('a/b/main.py')).toBe('python');
    expect(languageFromPath('x.ts')).toBe('typescript');
    expect(languageFromPath('x.mts')).toBe('typescript');
    expect(languageFromPath('x.jsx')).toBe('javascript');
  });

  it('по имени файла без расширения', () => {
    expect(languageFromPath('project/Dockerfile')).toBe('dockerfile');
    expect(languageFromPath('Makefile')).toBe('makefile');
  });

  it('неизвестное расширение → простой текст', () => {
    expect(languageFromPath('data.unknownext')).toBe(PLAIN_LANGUAGE);
    expect(languageFromPath('noextension')).toBe(PLAIN_LANGUAGE);
  });

  it('имя файла распознаётся без расширения', () => {
    // `.env` — файл-имя, а не просто расширение.
    expect(languageInfoForPath('.env')?.id).toBe('ini');
  });
});

describe('languageLabel / languageIndent', () => {
  it('человеческая подпись, а не сырой id', () => {
    expect(languageLabel('typescript')).toBe('TypeScript');
    expect(languageLabel('неизвестный')).toBe('неизвестный');
  });

  it('отступы по языку', () => {
    expect(languageIndent('makefile')).toEqual({ tabSize: 4, insertSpaces: false });
    expect(languageIndent('python')).toEqual({ tabSize: 4, insertSpaces: true });
    // У markdown своего отступа нет — берём общий из настроек редактора.
    expect(languageIndent('markdown')).toBeNull();
  });
});

describe('fileIconOf', () => {
  it('манифесты получают свой значок и подпись', () => {
    expect(fileIconOf('package.json')).toEqual({ kind: 'js', badge: 'NPM' });
    expect(fileIconOf('package-lock.json')).toEqual({ kind: 'lock', badge: '' });
  });

  it('картинки и архивы по расширению', () => {
    expect(fileIconOf('logo.svg').kind).toBe('image');
    expect(fileIconOf('archive.tar').kind).toBe('archive');
  });

  it('обычный код берёт значок языка', () => {
    expect(fileIconOf('main.py').kind).toBe('python');
  });
});
