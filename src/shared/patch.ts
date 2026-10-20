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

/** Сколько раз якорь встречается в тексте (неперекрывающиеся вхождения). */
export function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let at = text.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = text.indexOf(needle, at + needle.length);
  }
  return count;
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
        message: `${where}пустой якорь. Нужен точный текст из файла — прочитай его read_file и возьми фрагмент оттуда.`,
      };
    }

    const found = countOccurrences(text, patch.oldText);
    if (found === 0) {
      // Ближайшее место вместо «перечитай файл»: полное чтение стоит до 60 000
      // символов контекста, а подсказка с номером строки и соседними строками
      // отвечает на тот же вопрос за пару строк.
      const near = nearestPlace(text, patch.oldText);
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

    const at = text.indexOf(patch.oldText);
    const from = fromOffset(text, at);
    const to = fromOffset(text, at + patch.oldText.length);
    edits.push({
      startLine: from.line,
      startColumn: from.column,
      endLine: to.line,
      endColumn: to.column,
      newText: patch.newText,
      // Якорь кладём и в саму правку: документная модель сверит его ещё раз
      // перед применением — на случай гонки с чужой правкой в том же файле.
      oldText: patch.oldText,
    });
  }

  return { ok: true, edits };
}
