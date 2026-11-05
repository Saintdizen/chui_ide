/**
 * Можно ли дать файлу или папке такое имя. Отвечает причиной, а не только
 * «нет»: человек должен знать, что именно ему мешает.
 *
 * Проверка нужна там, где имя вводят руками — переименование и создание в
 * проводнике. Без неё `create` на занятое имя молча падает где-то в main,
 * а `folder/` создаёт вложенность вместо ошибки. На Linux запрещено мало что,
 * но «разрешено» не значит «разумно»: имя с пробелом в конце переживёт
 * создание и не найдётся поиском.
 */
export interface NameVerdict {
  readonly ok: boolean;
  /** Почему нельзя — только когда `ok === false`. */
  readonly reason?: string;
}

export interface NameCheckOptions {
  /** Имена, которые уже есть рядом; среди них может быть своё. */
  readonly siblings?: readonly string[];
  /**
   * Прежнее имя при переименовании. Совпадение с ним — не занятость, а «без
   * изменений»; записать его в список просто.
   */
  readonly original?: string;
  /** Windows иначе смотрит на двоеточия и зарезервированные имена. */
  readonly windows?: boolean;
}

/** Символы, которые не годятся в имя ни на одной из платформ. */
const ALWAYS_BAD = ['/', '\0'];

/** Windows запрещает их прямым текстом (плюс управляющие). */
const WINDOWS_BAD = ['<', '>', ':', '"', '\\', '|', '?', '*'];

/** Имена устройств DOS: файл `con.txt` на Windows открыть нельзя. */
const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

/**
 * Проверить имя. Не бросает и ничего не трогает — тупая функция для тестов
 * и для двух мест вызова (создать и переименовать).
 */
export function checkName(raw: string, options: NameCheckOptions = {}): NameVerdict {
  const name = raw;

  if (name.trim() === '') return { ok: false, reason: 'Имя не может быть пустым' };

  if (name !== name.trim()) {
    // Пробел в конце не видно глазом, а путь с ним уже другой.
    return { ok: false, reason: 'Имя не должно начинаться или кончаться пробелом' };
  }

  if (name === '.' || name === '..') {
    return { ok: false, reason: 'Так называется сама папка' };
  }

  for (const bad of ALWAYS_BAD) {
    if (name.includes(bad)) {
      return { ok: false, reason: `Имя не может содержать «${bad === '\0' ? '\\0' : bad}»` };
    }
  }

  // Управляющие символы не печатаются и ломают вывод путей.
  if ([...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    return { ok: false, reason: 'Имя не должно содержать управляющих символов' };
  }

  if (options.windows) {
    for (const bad of WINDOWS_BAD) {
      if (name.includes(bad)) {
        return { ok: false, reason: `Windows не разрешает «${bad}» в имени` };
      }
    }
    const stem = name.split('.')[0]?.toLowerCase() ?? '';
    if (WINDOWS_RESERVED.has(stem)) {
      return { ok: false, reason: `«${stem}» — зарезервированное имя Windows` };
    }
    if (name.endsWith('.')) {
      return { ok: false, reason: 'Windows не сохраняет точку в конце имени' };
    }
  }

  const siblings = options.siblings ?? [];
  const original = options.original?.toLowerCase();
  const lower = name.toLowerCase();
  if (lower !== original) {
    // Сравниваем без регистра: `Button.ts` и `button.ts` рядом — это не два
    // файла, а один и тот же на двух системах и в git.
    if (siblings.some((other) => other.toLowerCase() === lower)) {
      return { ok: false, reason: 'Такое имя уже есть в этой папке' };
    }
  }

  return { ok: true };
}
