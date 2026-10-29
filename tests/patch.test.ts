import { describe, expect, it } from 'vitest';
import { countOccurrences, resolvePatches } from '../src/shared/patch';
import { applyTextEdits } from '../src/shared/edits';

/**
 * Правки по якорю: позиции не называются, их считает документ.
 *
 * Здесь важен не только «счастливый путь», но и два отказа: якоря нет вовсе и
 * якорь не один. Оба должны быть сказаны словами — от этого зависит, догадается
 * ли модель взять фрагмент шире или перечитает файл.
 */

const FILE = [
  'def load(path):',
  '    text = read(path)',
  '    if not text:',
  "        raise ValueError('пусто')",
  '    return text',
  '',
].join('\n');

describe('resolvePatches: обычный случай', () => {
  it('находит якорь и считает позиции сам', () => {
    const result = resolvePatches(FILE, [{ oldText: 'read(path)', newText: 'read_file(path)' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [edit] = result.edits;
    // `read(path)` стоит на второй строке с 12-го символа (1-based); конец —
    // исключающий, как и везде в контракте правок (стиль LSP).
    expect(edit).toMatchObject({ startLine: 2, startColumn: 12, endLine: 2, endColumn: 22 });
    // Якорь кладётся и в правку: документ сверит его ещё раз перед применением.
    expect(edit?.oldText).toBe('read(path)');
    expect(applyTextEdits(FILE, result.edits)).toContain('text = read_file(path)');
  });

  it('кириллица не сбивает столбцы', () => {
    // Ровно та причина, ради которой якорь и заведён: столбцы для не-ASCII
    // модель считает на глаз, а поиск — точно.
    const result = resolvePatches(FILE, [
      { oldText: "raise ValueError('пусто')", newText: "raise ValueError('пусто!')" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(applyTextEdits(FILE, result.edits)).toContain("raise ValueError('пусто!')");
  });

  it('многострочный якорь: правка в середине блока', () => {
    const result = resolvePatches(FILE, [{ oldText: '    if not text:\n', newText: '' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(applyTextEdits(FILE, result.edits)).not.toContain('if not text:');
  });

  it('несколько патчей по порядку применяются оба', () => {
    const result = resolvePatches(FILE, [
      { oldText: 'load(path)', newText: 'load_source(path)' },
      { oldText: 'return text', newText: 'return text.strip()' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const applied = applyTextEdits(FILE, result.edits);
    expect(applied).toContain('def load_source(path):');
    expect(applied).toContain('return text.strip()');
  });

  it('каждый якорь ищется в исходном тексте, а не в результате соседнего патча', () => {
    // Порядок в наборе не важен: это набор мест одного документа, а не сценарий.
    // Якорь, которого в исходном тексте нет, честно отвергается — иначе пришлось
    // бы угадывать, что он появился от предыдущей правки.
    const result = resolvePatches('const a = 1;', [
      { oldText: 'const a = 1;', newText: 'const a = 100;' },
      { oldText: '= 100;', newText: '= 200;' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('не найден');
  });

  it('набор из независимых мест применяется целиком', () => {
    const text = 'one = 1\ntwo = 2\n';
    const result = resolvePatches(text, [
      { oldText: 'one = 1', newText: 'one = 10' },
      { oldText: 'two = 2', newText: 'two = 20' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(applyTextEdits(text, result.edits)).toBe('one = 10\ntwo = 20\n');
  });

  it('пустая замена удаляет найденное', () => {
    const result = resolvePatches(FILE, [{ oldText: '    if not text:\n', newText: '' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(applyTextEdits(FILE, result.edits).split('\n')).toHaveLength(5);
  });
});

describe('resolvePatches: отказы', () => {
  it('якоря нет — говорим прямо', () => {
    const result = resolvePatches(FILE, [{ oldText: 'нет такого текста', newText: 'x' }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('не найден');
    // Похожего места в файле нет — так и говорим, а не советуем читать всё заново.
    expect(result.message).toContain('Похожего места');
  });

  it('якорь с опечаткой — подсказка с настоящей строкой, а не «перечитай файл»', () => {
    // Отступ разошёлся — самая частая причина промаха. Вместо полного чтения
    // модели отдаётся номер строки и она сама с двумя соседними.
    const result = resolvePatches(FILE, [{ oldText: 'if not txet:', newText: 'x' }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('Похожее место');
    expect(result.message).toMatch(/строка \d+/);
    expect(result.message).toContain('    if not text:');
    // Полного текста файла в ответе нет: подсказка короткая.
    expect(result.message.length).toBeLessThan(600);
  });

  it('якорь встречается дважды — просим взять шире, а не угадываем', () => {
    const text = 'x = 1\ny = 1\n';
    const result = resolvePatches(text, [{ oldText: '= 1', newText: '= 2' }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('2 раз');
    expect(result.message).toContain('шире');
  });

  it('пустой якорь отвергается: нечего искать', () => {
    const result = resolvePatches(FILE, [{ oldText: '', newText: 'x' }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('пустой якорь');
  });

  it('номер правки назван, когда их несколько', () => {
    const result = resolvePatches(FILE, [
      { oldText: 'def load(path):', newText: 'def load(p):' },
      { oldText: 'не найдётся', newText: 'x' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('правка 2');
  });

  it('пустой список правок — ошибка, а не «применено 0»', () => {
    expect(resolvePatches(FILE, []).ok).toBe(false);
  });

  it('ничего не применяется, если хотя бы один якорь не сошёлся', () => {
    // Отказ до применения: правки возвращаются только целиком.
    const result = resolvePatches(FILE, [
      { oldText: 'load(path)', newText: 'load_source(path)' },
      { oldText: 'нет такого', newText: 'x' },
    ]);
    expect(result.ok).toBe(false);
  });
});

describe('невидимые символы в якоре', () => {
  const run = (text: string, oldText: string) => resolvePatches(text, [{ oldText, newText: 'X' }]);

  it('CRLF в файле, LF в якоре — находится', () => {
    // Файл на Windows несёт `\r\n`, а `read` отдаёт строки без `\r`.
    const r = run('function a() {\r\n  return 1;\r\n}\r\n', '  return 1;\n}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.edits[0]!.startLine).toBe(2);
      // `oldText` — реальный кусок файла (с `\r`), а не якорь агента: иначе
      // следующий шаг — сверка с документом — провалил бы якорь второй раз.
      expect(r.edits[0]!.oldText).toBe('  return 1;\r\n}');
    }
  });

  it('табы в файле, пробелы в якоре — находится', () => {
    const r = run('function a() {\n\treturn 1;\n}\n', '    return 1;\n}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.edits[0]!.oldText).toBe('\treturn 1;\n}');
  });

  it('CRLF и табы сразу — находится', () => {
    expect(run('if (x) {\r\n\treturn 1;\r\n}\r\n', '  return 1;\n}').ok).toBe(true);
  });

  it('два подходящих места — по-прежнему отказ', () => {
    // Снисходительность не должна превращать неоднозначность в догадку.
    expect(run('  a();\n  a();\n', '    a();').ok).toBe(false);
  });

  it('настоящий промах остаётся промахом', () => {
    expect(run('a\nb\n', 'zzz').ok).toBe(false);
  });

  it('точный якорь не трогаем — снисходительность не вступает', () => {
    const r = run('a\nb\n', 'a\nb');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.edits[0]!.oldText).toBe('a\nb');
  });
});

describe('якорь скопирован из вывода `read` с номерами строк', () => {
  const run = (text: string, oldText: string) => resolvePatches(text, [{ oldText, newText: 'X' }]);
  const FILE2 = ['function a() {', '  return 1;', '}', ''].join('\n');

  it('одиночная строка с номером — находится', () => {
    // `read` отдаёт «2 |   return 1;», и модель регулярно копирует якорь вместе
    // с номером. В файле номеров нет — без снисходительности был отказ.
    const r = run(FILE2, '2 |   return 1;');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.edits[0]!.startLine).toBe(2);
      // `oldText` — настоящий кусок файла, без номера и разделителя.
      expect(r.edits[0]!.oldText).toBe('  return 1;');
    }
  });

  it('номера с отступом слева — находятся', () => {
    expect(run(FILE2, '   2 |   return 1;').ok).toBe(true);
  });

  it('несколько строк с номерами — находятся', () => {
    const r = run(FILE2, '1 | function a() {\n2 |   return 1;');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.edits[0]!.oldText).toBe('function a() {\n  return 1;');
  });

  it('настоящая таблица `|` в коде — не путается с номерами', () => {
    // Одиночная строка без номера: снимать нечего, якорь ищется дословно.
    const text = 'const row = | a | b |;\n';
    expect(run(text, '| a | b |').ok).toBe(true);
  });

  it('неоднозначность после снятия номеров — по-прежнему отказ', () => {
    expect(run('  a();\n  a();\n', '1 |   a();').ok).toBe(false);
  });
});

describe('countOccurrences', () => {
  it('считает вхождения без перекрытий', () => {
    expect(countOccurrences('aaaa', 'aa')).toBe(2);
    expect(countOccurrences('abcabcabc', 'abc')).toBe(3);
    expect(countOccurrences('abc', 'z')).toBe(0);
    expect(countOccurrences('abc', '')).toBe(0);
  });
});
