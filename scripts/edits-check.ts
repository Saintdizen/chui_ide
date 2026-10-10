/**
 * Разовая проверка правок на не-ASCII тексте (замечание из задачи: на
 * кириллической строке apply_edit отчитался «применено 1», а файл не изменился).
 * Файл временный: компилируется отдельно от проекта и удаляется после прогона.
 */
import { applyTextEdits, type TextEdit } from '../src/shared/edits';

let failures = 0;

function check(name: string, run: () => void): void {
  try {
    run();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const file = ['// Комментарий на русском', 'const привет = "мир";', 'const tail = 1;', ''].join('\n');

check('кириллица: замена строки по позиции', () => {
  const oldText = 'const привет = "мир";';
  const edits: TextEdit[] = [
    { startLine: 2, startColumn: 1, endLine: 2, endColumn: oldText.length + 1, newText: 'const привет = "земля";' },
  ];
  const next = applyTextEdits(file, edits);
  assert(next.includes('"земля"'), `строка не заменилась: ${next}`);
});

check('кириллица: oldText совпадает — правка применяется', () => {
  const oldText = 'const привет = "мир";';
  const edits: TextEdit[] = [
    {
      startLine: 2,
      startColumn: 1,
      endLine: 2,
      endColumn: oldText.length + 1,
      newText: `const ответ = "да";`,
      oldText,
    },
  ];
  const next = applyTextEdits(file, edits);
  assert(next.includes('const ответ = "да";'), `правка не применилась: ${next}`);
  assert(!next.includes('привет'), 'старая строка осталась');
});

check('кириллица: oldText не совпадает — ошибка, а не тихая порча', () => {
  const edits: TextEdit[] = [
    {
      startLine: 2,
      startColumn: 1,
      endLine: 2,
      endColumn: 8,
      newText: 'const ZZZ = 1;',
      oldText: 'const привет',
    },
  ];
  let message = '';
  try {
    applyTextEdits(file, edits);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes('не совпала с текстом документа'), `ожидалась ошибка сверки, получено: «${message}»`);
  assert(message.includes('символов'), `в сообщении не указана длина: «${message}»`);
});

check('сдвиг колонок из-за разных длин строк ловится сверкой', () => {
  // Модель посчитала колонку по подсказке, где кириллица короче — правка
  // попала бы в середину строки; с oldText это несоответствие видно сразу.
  const oldText = 'const tail = 1;';
  const edits: TextEdit[] = [
    {
      startLine: 3,
      startColumn: 1,
      endLine: 3,
      endColumn: oldText.length + 1,
      newText: 'const tail = 2;',
      oldText,
    },
  ];
  const next = applyTextEdits(file, edits);
  assert(next.includes('const tail = 2;'), `правка не применилась: ${next}`);
});

check('несколько правок с якорями применяются с конца', () => {
  const first = '// Комментарий на русском';
  const second = 'const tail = 1;';
  const edits: TextEdit[] = [
    { startLine: 1, startColumn: 1, endLine: 1, endColumn: first.length + 1, newText: '// Заголовок', oldText: first },
    {
      startLine: 3,
      startColumn: 1,
      endLine: 3,
      endColumn: second.length + 1,
      newText: 'const tail = 2;',
      oldText: second,
    },
  ];
  const next = applyTextEdits(file, edits);
  assert(next.startsWith('// Заголовок'), `первая правка не применилась: ${next}`);
  assert(next.includes('const tail = 2;'), `вторая правка не применилась: ${next}`);
});

console.log(failures === 0 ? '[chui] правки текста с не-ASCII работают' : '');
if (failures > 0) throw new Error(`провалов: ${failures}`);
