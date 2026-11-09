import { describe, expect, it } from 'vitest';
import { heldTail, stripCallMarkup } from '../src/shared/call-markup';

/**
 * Ответ в режиме «Вопрос»: инструментов модели не дают, но не всякая модель
 * это принимает и пишет вызов текстом. В окно не должны попадать служебные
 * токены — человек спрашивал про дело, а не про разметку.
 */
describe('stripCallMarkup', () => {
  it('обычный текст не трогает', () => {
    const text = 'Функция `read()` читает файл. [1] — сноска, и это нормально.';
    expect(stripCallMarkup(text)).toBe(text);
  });

  it('вырезает блок DSML в полноширинных чертах', () => {
    const text = [
      'Проверил: файл на месте.',
      '',
      '\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke name="read"',
      '{"path":"/tmp/a.txt"}',
      '\uFF5C\uFF5C/DSML\uFF5C\uFF5C',
      '',
      'Больше ничего не нужно.',
    ].join('\n');
    const clean = stripCallMarkup(text);
    expect(clean).not.toContain('DSML');
    expect(clean).not.toContain('invoke');
    expect(clean).toContain('файл на месте');
    expect(clean).toContain('Больше ничего не нужно.');
  });

  it('обрезанный DSML без закрывающей пары тоже убирает', () => {
    const text = 'Ответ по делу.\n\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke name="terminal" {"com';
    const clean = stripCallMarkup(text);
    expect(clean).toBe('Ответ по делу.');
  });

  it('вырезает XML-форму вызова, как её шлют другие модели', () => {
    const text = 'Итог: изменений нет.\n<tool_call>{"name":"read","path":"x"}</tool_call>';
    const clean = stripCallMarkup(text);
    expect(clean).toBe('Итог: изменений нет.');
  });

  it('не вырезает квадратные скобки из обычной речи', () => {
    const text = 'Смотри [документацию] и [2]. Это важно.';
    expect(stripCallMarkup(text)).toBe(text);
  });

  it('идемпотентен: второй прогон ничего не меняет', () => {
    const text = 'Текст.\n\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke name="read" {}\uFF5C\uFF5C/DSML\uFF5C\uFF5C';
    const once = stripCallMarkup(text);
    expect(stripCallMarkup(once)).toBe(once);
  });

  it('пустой ответ остаётся пустым', () => {
    expect(stripCallMarkup('')).toBe('');
  });

  /**
   * Обрыв прогона кнопкой «стоп» приходит на середине ответа и на середине
   * вызова. В историю уходит то же, что человек видел в ленте, — значит
   * недописанный вызов не должен попасть в неё как реплика модели.
   */
  it('обрыв на середине вызова не оставляет в истории мусора', () => {
    const text = 'Сейчас прочитаю файл.\n\uFF5C\uFF5CDSML\uFF5C\uFF5Cinvoke name="read" {"pa';
    expect(stripCallMarkup(text)).toBe('Сейчас прочитаю файл.');
  });
});

/**
 * Поток. Разметка приходит кусками, и до развязки непонятно, разметка это или
 * текст: `｜` — первый символ пары, `DSML` — ещё слово. Показывать можно только
 * то, что уже не может дорасти до вызова.
 */
describe('heldTail: сколько хвоста ждать', () => {
  it('у обычного текста не держит ничего', () => {
    expect(heldTail('Ответ по делу. Всё на месте.')).toBe(0);
  });

  it('держивает первую черту пары', () => {
    // Разметка начинается с новой строки — ждёт всё, что после неё.
    expect(heldTail('Ответ.\n\uFF5C')).toBe(1);
    // Черта посреди строки — подозрительна целиком: удержать надо всю хвостовую
    // часть строки, а не один символ, иначе перед чертой успеет мелькнуть
    // половина служебного слова.
    expect(heldTail('Ответ. Похоже, \uFF5C')).toBe('Ответ. Похоже, '.length + 1);
  });

  it('держивает тело вызова между чертами', () => {
    expect(heldTail('Ответ.\n\uFF5CDSML\uFF5C\uFF5Cinvoke name="read"')).toBeGreaterThan(10);
  });

  it('незакрытый тег в конце тоже ждёт', () => {
    expect(heldTail('Ответ.\n<tool_cal')).toBe(9);
  });

  it('обычный `<b>` в тексте не держит', () => {
    expect(heldTail('Это <b')).toBe(0);
  });
});
