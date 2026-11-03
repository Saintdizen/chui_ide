import { describe, expect, it } from 'vitest';
import { cleanPastedText } from '../src/shared/paste-clean';

/**
 * Вставка в редактор уже берёт только `text/plain` — HTML из буфера не приходит.
 * Но «форматирование» приезжает и внутри текста, невидимыми знаками: глаза их
 * не видят, а компилятор, поиск и диф — очень.
 */
describe('cleanPastedText', () => {
  it('неразрывный пробел становится обычным', () => {
    // Классика из веба: «const\u00a0x» — глазами пробел, для компилятора не пробел.
    expect(cleanPastedText('const\u00a0x = 1;')).toBe('const x = 1;');
  });

  it('знаки нулевой ширины снимаются', () => {
    expect(cleanPastedText('co\u200bde')).toBe('code');
  });

  it('метка порядка байтов снимается', () => {
    expect(cleanPastedText('\ufeffconst x = 1;')).toBe('const x = 1;');
  });

  it('мягкий перенос снимается', () => {
    expect(cleanPastedText('code\u00adbase')).toBe('codebase');
  });

  it('Windows-переводы строк становятся обычными', () => {
    // Иначе в конце каждой строки остаётся невидимый `\r`.
    expect(cleanPastedText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('разделитель строк из PDF — перевод строки', () => {
    expect(cleanPastedText('a\u2028b')).toBe('a\nb');
  });

  it('табуляция остаётся: она значит дело', () => {
    expect(cleanPastedText('\tfoo')).toBe('\tfoo');
  });

  it('обычный текст не трогается', () => {
    const text = 'const x = "مرحبا"; // обычная строка';
    expect(cleanPastedText(text)).toBe(text);
  });

  it('склейка эмодзи остаётся: ZWJ — не мусор', () => {
    /**
     * Линтер поймал это в первом варианте: `\u200d` стоял в классе невидимых, и
     * составные эмодзи разваливались — семья из одного знака превращалась в
     * пятерых. Стереть невидимое и стереть значимое — не одно и то же.
     */
    const family = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}';
    expect(cleanPastedText(family)).toBe(family);
  });
});
