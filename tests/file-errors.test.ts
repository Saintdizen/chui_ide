import { describe, expect, it } from 'vitest';
import { describeFileError, errorCode } from '../src/renderer/core/file-errors';

/**
 * Причина файлового отказа — словами.
 *
 * ПОВОД: в `file-mutation-commands.ts` перенос и копирование ловили ошибку
 * голым `catch {}` и на ЛЮБУЮ показывали «в целевой папке уже есть такое имя».
 * Переименовал файл без прав — человек шёл искать несуществующего тёзку.
 * Ветка жила с правами root, поэтому отказ вылез только у пользователя.
 */
describe('код из ошибки', () => {
  it('берёт прямой код', () => {
    expect(errorCode({ code: 'EACCES' })).toBe('EACCES');
  });

  it('достаёт код из `details` — так его кладёт RpcError', () => {
    expect(errorCode({ message: 'не удалось', details: { code: 'ENOENT' } })).toBe('ENOENT');
  });

  it('запасной путь — по тексту сообщения', () => {
    expect(errorCode(new Error('ENOENT: no such file or directory, open /p/a'))).toBe('ENOENT');
  });

  it('не выдумывает код, когда его нет', () => {
    // Иначе любой текст с заглавным словом стал бы «системным кодом».
    expect(errorCode(new Error('что-то пошло не так'))).toBeNull();
    expect(errorCode('строка')).toBeNull();
    expect(errorCode(null)).toBeNull();
  });
});

describe('что сказать человеку', () => {
  it('права — не «имя занято»', () => {
    // Главная ошибка, ради которой модуль и появился.
    const text = describeFileError({ code: 'EACCES' });
    expect(text).toMatch(/прав/i);
    expect(text).not.toMatch(/занят/i);
  });

  it('каждый частый код говорит своё', () => {
    expect(describeFileError({ code: 'ENOENT' })).toMatch(/исчез|Не найдено/i);
    expect(describeFileError({ code: 'ENOSPC' })).toMatch(/места/i);
    expect(describeFileError({ code: 'ENAMETOOLONG' })).toMatch(/длинн/i);
    expect(describeFileError({ code: 'EXDEV' })).toMatch(/диск/i);
    expect(describeFileError({ code: 'EBUSY' })).toMatch(/открыт/i);
  });

  it('подставляет объект в текст', () => {
    expect(describeFileError({ code: 'EEXIST' }, 'папка')).toMatch(/папка/);
  });

  it('незнакомый код всё равно называет', () => {
    // Молчание хуже: «система ответила EZZZ» хотя бы не врёт и даёт что гуглить.
    expect(describeFileError({ code: 'EZZZ' })).toContain('EZZZ');
  });

  it('нет кода и нет смысла — null, пусть решает вызывающий', () => {
    expect(describeFileError(new Error('нет'))).toBeNull();
  });
});
