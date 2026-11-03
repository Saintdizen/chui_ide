import { describe, expect, it } from 'vitest';
import { detectIndent, resolveIndent } from '../src/shared/indent';

/**
 * Часть 15 п.4: отступ определяется по файлу, а не по языку вообще.
 *
 * Найдено разбором: `insertSpaces` был описан в `LanguageIndent` и заведён у
 * Makefile и Go — но НИГДЕ не читался. `EditorController.indent()` всегда вставлял
 * пробелы, `reindentPasted` знал только `tabSize`. Полоса статуса при этом
 * показывала «табы»: она читала `insertSpaces` из языка, которого больше никто
 * не слушал.
 */
describe('detectIndent: по содержимому файла', () => {
  it('пробелы по два — так и есть', () => {
    expect(detectIndent(['if (a) {', '  b();', '  c();', '}'])).toEqual({ tabSize: 2, insertSpaces: true });
  });

  it('пробелы по четыре — так и есть', () => {
    expect(detectIndent(['def f():', '    return 1', '    pass'])).toEqual({ tabSize: 4, insertSpaces: true });
  });

  it('табы определяются как табы', () => {
    expect(detectIndent(['all:', '\t@echo 1', '\t@echo 2'])?.insertSpaces).toBe(false);
  });

  it('вложенный отступ не удваивает шаг', () => {
    // ГЛАВНАЯ грабля: если брать НАИБОЛЬШИЙ отступ, вложенная строка даст восемь
    // там, где шаг — четыре, и весь файл начнёт краснеть по два шага за раз.
    expect(detectIndent(['a', '    b', '        c'])).toEqual({ tabSize: 4, insertSpaces: true });
  });

  it('шаг в три пробела не спутать с выравниванием', () => {
    expect(detectIndent(['a', '   b', '   c'])).toEqual({ tabSize: 3, insertSpaces: true });
  });

  it('пустой промежуток из одного пробела — не шаг: возвращаем четыре', () => {
    // Один пробел часто стоит перед звёздочкой блочного комментария — это не отступ.
    expect(detectIndent(['a', ' b', ' c'])).toEqual({ tabSize: 4, insertSpaces: true });
  });

  it('файл без отступов ничего не доказывает', () => {
    // Это НЕ «пробелы по четыре»: так мы навязали бы выбор, которого человек не делал.
    expect(detectIndent(['a', 'b', 'c'])).toBeNull();
  });

  it('пустой файл — тоже ничего', () => {
    expect(detectIndent([])).toBeNull();
    expect(detectIndent(['', '   ', ''])).toBeNull();
  });

  it('одной строки с отступом мало', () => {
    expect(detectIndent(['a', '  b'])).toBeNull();
  });

  it('таб сильнее пробела: один таб перевешивает', () => {
    expect(detectIndent(['  a', '  b', '\tc', '\td'])?.insertSpaces).toBe(false);
  });

  it('смесь таба с пробелами считается табом', () => {
    // Ширину такого отступа задаёт таб, а не пробелы после него.
    expect(detectIndent(['\t  a', '\t  b'])?.insertSpaces).toBe(false);
  });

  it('дальше двухсот строк не смотрит: решает начало файла', () => {
    // В конце файла может лежать чужой кусок — он не должен менять отступ всего
    // файла. Хвост короткий ровно настолько, чтобы не перевесить начало: в
    // начале 100 строк с двумя пробелами, в хвосте — всего пять с табами.
    const head = Array.from({ length: 100 }, () => '  b');
    const tail = Array.from({ length: 5 }, () => '\t\tzz');
    expect(detectIndent([...head, ...tail])).toEqual({ tabSize: 2, insertSpaces: true });
  });

  it('но если табы набирают вес — они и решают', () => {
    // Обратная сторона той же границы: смотреть только начало — не значит
    // закрывать глаза на то, что там реально написано.
    const head = ['  b', '  c'];
    const tail = Array.from({ length: 300 }, () => '\t\tzz');
    // Шаг при табах из файла не виден — отвечаем привычными четырьмя.
    expect(detectIndent([...head, ...tail])).toEqual({ tabSize: 4, insertSpaces: false });
  });
});

describe('resolveIndent: файл, язык, настройки — в этом порядке', () => {
  const settings = { tabSize: 4, insertSpaces: true };

  it('файл перебивает язык', () => {
    // TypeScript на табах — норма; навязывать ему пробелы значило бы портить
    // каждую новую строку, которую он начнёт.
    expect(resolveIndent({ tabSize: 8, insertSpaces: false }, { tabSize: 2, insertSpaces: true }, settings)).toEqual({
      tabSize: 8,
      insertSpaces: false,
    });
  });

  it('нет улик в файле — слово за языком', () => {
    expect(resolveIndent(null, { tabSize: 4, insertSpaces: false }, settings)).toEqual({
      tabSize: 4,
      insertSpaces: false,
    });
  });

  it('язык молчит — берём настройку человека', () => {
    expect(resolveIndent(null, undefined, { tabSize: 2, insertSpaces: true })).toEqual({
      tabSize: 2,
      insertSpaces: true,
    });
  });
});
