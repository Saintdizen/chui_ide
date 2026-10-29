/**
 * Правки по якорю — «найди этот текст, замени на этот».
 *
 * Зачем рядом с правкой по позициям: та требует позиций (строка и столбец), и их надо
 * *назвать*. Для текста с кириллицей и для файла, который сдвинулся после чужой
 * правки, это главный источник промахов: модель считает столбцы на глаз. Здесь
 * позиции не называются вовсе — их считаем мы, найдя якорь в самом документе.
 * Промах при этом невозможен по построению: не нашли текст — правка не делается,
 * а не «попадает» в похожее место.
 *
 * Якорь обязан быть единственным. Если такой текст в файле встречается дважды,
 * это не задача для угадывания: подсказываем агенту взять якорь шире (с соседней
 * строкой, отступом, именем функции) — тогда он снова станет единственным.
 *
 * Модуль чистый: ни DOM, ни ФС. Разрешение якорей проверяется тестами, а
 * применение результата идёт обычным путём правки (см. shared/edits.ts) —
 * поэтому undo, ревью и пометки «не сохранён» работают как раньше.
 */

import { fromOffset, type TextEdit } from './edits';

/** Одна замена: что найти и на что заменить. */
export interface PatchHunk {
  /** Точный текст из файла, который нужно заменить. Обязан быть единственным. */
  oldText: string;
  /** Чем заменить. Пустая строка удаляет найденное. */
  newText: string;
}

/** Патчи одного файла. Путь абсолютный — как у правки по позициям. */
export interface PatchFile {
  path: string;
  patches: PatchHunk[];
}

export type PatchResolution = { ok: true; edits: TextEdit[] } | { ok: false; message: string };

/** Потолок правок на файл: защита от вырожденного ответа модели, как у правки по позициям. */
const MAX_PATCHES = 200;

/** Короткий вид фрагмента для сообщения об ошибке: многострочный текст не тащим. */
function cut(value: string, limit = 80): string {
  const flat = value.replace(/\n/g, '⏎');
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/**
 * Ближайшее к якорю место в файле: где нашлась его первая содержательная строка.
 *
 * Якорь обычно не сходится из-за отступа, кавычек или одной изменённой буквы, и
 * «перечитай файл целиком» — дорогой ответ на дешёвый вопрос. Ищем по первой
 * непустой строке якоря (без отступа, обрезанной до разумной длины) и отдаём
 * саму строку с двумя соседними: по ним видно, что не так, и можно скопировать
 * текст в якорь.
 *
 * `null` — ничего похожего: значит, якорь из другого файла или место уже переписано.
 */
export function nearestPlace(text: string, anchor: string): { line: number; snippet: string } | null {
  const first = anchor.split('\n').find((row) => row.trim().length >= 3);
  if (!first) return null;
  const needle = first.trim().slice(0, 80);
  if (needle.length < 3) return null;

  const rows = text.split('\n');
  // Ищем по обрезанной строке: отступ в якоре — самая частая причина промаха.
  // Строка могла разойтись и в конце (опечатка, другой регистр) — тогда пробуем
  // всё более короткие её начала. Короче шести символов не берём: такой префикс
  // совпадёт где угодно и подсказка будет врать.
  let at = -1;
  for (const length of [needle.length, 40, 20, 12, 8, 6]) {
    if (length > needle.length || length < 6) continue;
    const prefix = needle.slice(0, length);
    // Нужны буквы или цифры: префикс из скобок и отступов ничего не значит.
    if (!/[\p{L}\p{N}]{3}/u.test(prefix)) continue;
    at = rows.findIndex((row) => row.trim().includes(prefix));
    if (at >= 0) break;
  }
  if (at < 0) return null;

  const from = Math.max(0, at - 2);
  const to = Math.min(rows.length - 1, at + 2);
  const width = String(to + 1).length;
  const snippet = rows
    .slice(from, to + 1)
    .map((row, index) => `${String(from + index + 1).padStart(width, ' ')} | ${row}`)
    .join('\n');
  return { line: at + 1, snippet };
}

/** Вхождение якоря в тексте: где начинается и где кончается. */
interface Occurrence {
  start: number;
  end: number;
}

/** Все неперекрывающиеся вхождения подстроки. */
export function occurrences(text: string, needle: string): Occurrence[] {
  if (!needle) return [];
  const hits: Occurrence[] = [];
  let at = text.indexOf(needle);
  while (at !== -1) {
    hits.push({ start: at, end: at + needle.length });
    at = text.indexOf(needle, at + needle.length);
  }
  return hits;
}

/** Сколько раз якорь встречается в тексте (неперекрывающиеся вхождения). */
export function countOccurrences(text: string, needle: string): number {
  return occurrences(text, needle).length;
}

/**
 * Вхождения якоря с поправкой на невидимое: перевод строки и общий отступ.
 *
 * В выводе `read` агент не видит ни `\r`, ни табов: строка выглядит как
 * `  return 1;`, а в файле лежит `\treturn 1;\r\n`. Дословный поиск такой якорь
 * не находит, и правка отказывается, хотя место агентом указано верно. Поэтому
 * здесь текст и якорь приводятся к одному виду (CRLF → LF), а у строк якоря
 * отбрасывается общий отступ: он в якоре — украшение, в файле — его нет.
 *
 * Снисходительность узкая и в одну сторону: якорь ищется только если он точный
 * у всех строк с точностью до отступа. Несколько вхождений — по-прежнему отказ
 * (см. `resolvePatches`): угадывать, какое из них имелось в виду, нельзя.
 */
function occurrencesLoose(text: string, anchor: string): Occurrence[] {
  const want = anchor.split('\n').map((line) => line.replace(/\r$/, '').trim());
  // Якорь из одних пробелов ничего не говорит о месте — не угадываем.
  if (want.join('').length === 0) return [];

  // Идём по строкам файла и сравниваем их без отступа: для якоря и для файла
  // срез один и тот же, поэтому таб и пробелы перестают иметь значение.
  const rows = text.split('\n');
  const stripped = rows.map((row) => row.replace(/\r$/, '').trim());
  const hits: Occurrence[] = [];
  const offsets = lineOffsets(text);

  for (let start = 0; start + want.length <= rows.length; start += 1) {
    let same = true;
    for (let i = 0; i < want.length; i += 1) {
      if (stripped[start + i] !== want[i]) {
        same = false;
        break;
      }
    }
    if (!same) continue;
    const begin = offsets[start]!;
    const last = start + want.length - 1;
    // Конец — по концу последней строки БЕЗ её `\r`: якорь перевод строки не захватывает.
    const end = offsets[last]! + rows[last]!.replace(/\r$/, '').length;
    hits.push({ start: begin, end });
  }
  return hits;
}

/**
 * Номер строки из вывода `read` перед самой строкой: `412 | const x = 1;`.
 *
 * `read` нумерует строки (по ним адресуются `startLine`/`endLine`), и модель
 * регулярно копирует якорь ВМЕСТЕ с номером. В файле таких номеров нет — якорь
 * не находился, и правка отказывалась на ровном месте (30% отказов `edit` по
 * телеметрии).
 */
const READ_LINE_NUMBER = /^\s*\d+\s*\|\s?/;

/**
 * Снять номера строк, если якорь — копия вывода `read` с номерами.
 *
 * Требуем номера у большинства непустых строк: одиночная строка вида
 * `2 | x` может быть и настоящей таблицей в коде, и тогда снимать нечего.
 * `null` — якорь не нумерованный, трогать его нельзя.
 */
export function stripReadNumbers(anchor: string): string | null {
  const lines = anchor.split('\n');
  const filled = lines.filter((line) => line.trim().length > 0);
  const numbered = filled.filter((line) => READ_LINE_NUMBER.test(line));
  if (numbered.length === 0) return null;
  if (numbered.length * 4 < filled.length * 3) return null;
  return lines.map((line) => line.replace(READ_LINE_NUMBER, '')).join('\n');
}

/** Смещение начала каждой строки в тексте (разбиение по `\n`). */
function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

/**
 * Разрешить якоря в правки с позициями.
 *
 * Каждый якорь ищется в ИСХОДНОМ тексте файла и обязан быть там единственным.
 * Так патчи не зависят друг от друга и от порядка: набор — это набор мест одного
 * документа, а не сценарий из последовательных шагов. Позиции считаются тут же,
 * потому что дальше их ждёт `applyTextEdits` — тот же путь, что у правки по позициям,
 * и, значит, то же ревью, undo и «документ изменён».
 */
export function resolvePatches(text: string, patches: readonly PatchHunk[]): PatchResolution {
  if (patches.length === 0) return { ok: false, message: 'Не передано ни одной правки' };
  if (patches.length > MAX_PATCHES) {
    return { ok: false, message: `Слишком много правок за один вызов: ${patches.length} (максимум ${MAX_PATCHES})` };
  }

  const edits: TextEdit[] = [];

  for (const [index, patch] of patches.entries()) {
    const where = patches.length > 1 ? `правка ${index + 1}: ` : '';
    if (patch.oldText.length === 0) {
      return {
        ok: false,
        message: `${where}пустой якорь. Нужен точный текст из файла — прочитай его read и возьми фрагмент оттуда.`,
      };
    }

    // Якорь ищем в два приёма. Сначала дословно: это точное место, и если оно
    // ровно одно — вопросов нет. Потом с поправкой на невидимое: перевод строки
    // и общий отступ. Их агент не видит в выводе `read`, а файл на диске живёт
    // с ними (CRLF после Windows, табы, вложенность). Раньше такой якорь просто
    // «не находился», и правка отказывалась на ровном месте.
    // ...а перед этим — снять номера строк, если якорь скопирован из вывода
    // `read` вместе с ними: в файле номеров нет.
    const wanted = stripReadNumbers(patch.oldText) ?? patch.oldText;
    const exact = occurrences(text, patch.oldText);
    const bare = exact.length > 0 || wanted === patch.oldText ? [] : occurrences(text, wanted);
    const loose = exact.length > 0 || bare.length > 0 ? [] : occurrencesLoose(text, wanted);
    const hits = exact.length > 0 ? exact : bare.length > 0 ? bare : loose;
    const found = hits.length;
    if (found === 0) {
      // Ближайшее место вместо «перечитай файл»: полное чтение стоит до 60 000
      // символов контекста, а подсказка с номером строки и соседними строками
      // отвечает на тот же вопрос за пару строк.
      const near = nearestPlace(text, wanted);
      const hint = near
        ? `\nПохожее место — строка ${near.line}:\n${near.snippet}\n` +
          'Возьми якорь отсюда дословно: важен каждый пробел и перевод строки.'
        : '\nПохожего места в файле нет — возможно, фрагмент из другого файла или его уже переписали.';
      return {
        ok: false,
        message:
          `${where}текст «${cut(patch.oldText)}» в файле не найден.${hint}` +
          ' Если место уже заменено другой правкой этого вызова — учти, что каждая правка ищется в исходном тексте.',
      };
    }
    if (found > 1) {
      return {
        ok: false,
        message:
          `${where}текст «${cut(patch.oldText)}» встречается в файле ${found} раз — непонятно, какой менять. ` +
          'Возьми якорь шире: добавь соседнюю строку, отступ или имя функции — чтобы он стал единственным.',
      };
    }

    // Позиция — по найденному вхождению, а `oldText` — РЕАЛЬНЫЙ кусок файла (у
    // невидимого якоря он отличается от того, что прислал агент). Так документная
    // модель сверит не пустое место: её следующий шаг — сравнить `oldText` с тем,
    // что лежит в документе, и якорь агента там провалился бы второй раз.
    const hit = hits[0]!;
    const from = fromOffset(text, hit.start);
    const to = fromOffset(text, hit.end);
    edits.push({
      startLine: from.line,
      startColumn: from.column,
      endLine: to.line,
      endColumn: to.column,
      newText: patch.newText,
      // Якорь кладём и в саму правку: документная модель сверит его ещё раз
      // перед применением — на случай гонки с чужой правкой в том же файле.
      oldText: text.slice(hit.start, hit.end),
    });
  }

  return { ok: true, edits };
}
