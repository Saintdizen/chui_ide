/**
 * Правки по якорю — «найди этот текст, замени на этот».
 *
 * Зачем рядом с `apply_edit`: тот требует позиций (строка и столбец), и их надо
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
 * применение результата идёт обычным путём `apply_edit` (см. shared/edits.ts) —
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

/** Патчи одного файла. Путь абсолютный — как у `apply_edit`. */
export interface PatchFile {
  path: string;
  patches: PatchHunk[];
}

export type PatchResolution = { ok: true; edits: TextEdit[] } | { ok: false; message: string };

/** Потолок правок на файл: защита от вырожденного ответа модели, как у apply_edit. */
const MAX_PATCHES = 200;

/** Короткий вид фрагмента для сообщения об ошибке: многострочный текст не тащим. */
function cut(value: string, limit = 80): string {
  const flat = value.replace(/\n/g, '⏎');
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
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
 * потому что дальше их ждёт `applyTextEdits` — тот же путь, что у `apply_edit`,
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
      return {
        ok: false,
        message:
          `${where}текст «${cut(patch.oldText)}» в файле не найден. ` +
          'Перечитай файл (read_file) и возьми якорь дословно: важен каждый пробел и перевод строки. ' +
          'Если место уже заменено другой правкой этого вызова — учти, что каждая правка ищется в исходном тексте.',
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

/**
 * Разбор аргумента инструмента: модель — недоверенный источник, поэтому и
 * структура, и типы проверяются вручную. Проверка позиций не нужна — их здесь нет.
 */
export function parsePatchFiles(value: unknown): PatchFile[] {
  if (!Array.isArray(value)) throw new Error('Аргумент «patches» должен быть массивом');
  if (value.length === 0) throw new Error('Не передано ни одной правки');

  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`patches[${index}]: ожидался объект`);
    }
    const raw = item as Record<string, unknown>;
    const filePath = raw.path;
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      throw new Error(`patches[${index}]: не задан path`);
    }
    const list = raw.patches;
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(`patches[${index}].patches: нужен непустой массив правок`);
    }

    const patches = list.map((entry, patchIndex) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new Error(`patches[${index}].patches[${patchIndex}]: ожидался объект`);
      }
      const hunk = entry as Record<string, unknown>;
      if (typeof hunk.oldText !== 'string') {
        throw new Error(`patches[${index}].patches[${patchIndex}].oldText: нужна строка`);
      }
      if (typeof hunk.newText !== 'string') {
        throw new Error(`patches[${index}].patches[${patchIndex}].newText: нужна строка`);
      }
      return { oldText: hunk.oldText, newText: hunk.newText };
    });

    return { path: filePath, patches };
  });
}
