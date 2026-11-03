/**
 * Последствие шага — одной строкой, до нажатия «Разрешить».
 *
 * Карточка подтверждения показывает команду, и это честно, но мало: `rm -rf build`
 * и `npm test` выглядят одинаково длинной строкой, а стоят разного. Человек,
 * который не узнаёт последствие с первого взгляда, через десять вопросов начинает
 * нажимать не читая — и тогда подтверждение перестаёт что-либо значить.
 *
 * Здесь нет ни модели, ни сети: только разбор того, что и так известно. Всё
 * непонятное честно называется «не могу сказать» — врать про последствие хуже,
 * чем промолчать.
 *
 * Модуль чистый: ни DOM, ни RPC, ни времени. Зовёт его `chat-approvals.ts`.
 */

/** Насколько шаг необратим. Порядок важен: сравнивается `>` в `worstOf`. */
export type DangerLevel = 'safe' | 'writes' | 'destroys' | 'unknown';

const RANK: Record<DangerLevel, number> = { safe: 0, writes: 1, destroys: 2, unknown: 3 };

/** Худшее из двух: карточка говорит про весь шаг, а не про добрую его половину. */
export function worstOf(a: DangerLevel, b: DangerLevel): DangerLevel {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * Что случится — но только когда это видно из самой команды.
 *
 * Список короткий и намеренно ручной. Регулярка на `rm` не поймает `find -delete`,
 * а широкое «есть слово delete — опасно» сработает на `grep delete file.ts` и
 * приучит не верить подписи. Лучше пропустить и сказать «не могу сказать»:
 * модельная проверка (`approval-review.ts`) закрывает остальное.
 */
const DESTROYS: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*\s+)?-?[a-zA-Z]*[rf]/, what: 'удалит файлы без корзины, рекурсивно' },
  { pattern: /\brm\s+\S/, what: 'удалит файлы без корзины' },
  { pattern: /\bgit\s+push\b.*--force\b|\bgit\s+push\b.*\s-f\b/, what: 'перезапишет историю в удалённом репозитории' },
  { pattern: /\bgit\s+reset\s+--hard\b/, what: 'сбросит незакоммиченные правки' },
  { pattern: /\bgit\s+clean\b.*-[a-zA-Z]*[fd]/, what: 'удалит неотслеживаемые файлы' },
  { pattern: /\bsudo\b/, what: 'выполнится от администратора' },
  // `find -delete` и `-exec rm` — тот же `rm`, только имя файла выбирает find.
  // Без этой строки самое ходовое удаление в проекте проходило как безопасное.
  { pattern: /\bfind\b.*(-delete\b|-exec\s+rm\b)/, what: 'удалит найденные файлы без корзины' },
  // `curl … | sh` — выполнит чужой код от вашего имени. Необратимо не потому,
  // что удаляет, а потому, что мы не знаем, что именно запустили.
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(ba|z|da|k)?sh\b/, what: 'выполнит чужой код из сети' },
  { pattern: /\b(drop|truncate)\s+(table|database)\b/i, what: 'удалит данные из базы' },
  { pattern: /\bmkfs\b|\bdd\s+if=/, what: 'перезапишет диск' },
];

/** Пишет, но откатываемо: рабочее дерево, зависимости, буфер обмена пакетов. */
const WRITES: RegExp[] = [
  /\bnpm\s+(i|install|ci|uninstall|update|publish)\b/,
  /\bpnpm\s+(add|install|remove|update)\b/,
  /\byarn\s+(add|install|remove)\b/,
  /\bgit\s+(commit|merge|rebase|cherry-pick|stash|switch|checkout|restore)\b/,
  />/,
  /\bmv\b|\bcp\b|\bmkdir\b|\btouch\b|\bchmod\b|\bchown\b/,
];

export interface CommandConsequence {
  level: DangerLevel;
  /** Одна фраза, которая встанет под командой. `null` — сказать нечего. */
  note: string | null;
}

/**
 * Последствие команды оболочки.
 *
 * Ищется ПЕРВОЕ совпадение опасного списка: если команда и удаляет, и ставит
 * зависимости, человеку важнее первое. Пишущие проверяются только после — иначе
 * `> файл` внутри `rm`-команды перебил бы удаление.
 */
export function commandConsequence(command: string): CommandConsequence {
  const oneLine = command.replace(/\s+/g, ' ').trim();
  if (!oneLine) return { level: 'safe', note: null };

  for (const { pattern, what } of DESTROYS) {
    if (pattern.test(oneLine)) return { level: 'destroys', note: what };
  }
  for (const pattern of WRITES) {
    if (pattern.test(oneLine)) return { level: 'writes', note: 'изменит файлы или зависимости' };
  }
  if (
    /^\s*(ls|cat|head|tail|grep|rg|find|git\s+(status|log|diff|show|branch)|npm\s+test|npm\s+run|pwd|echo|wc|cd|which|type)\b/.test(
      oneLine,
    )
  ) {
    return { level: 'safe', note: null };
  }
  // Не знаем — говорим так и говорим. Молчание читается как «всё в порядке».
  return { level: 'unknown', note: null };
}

/** Правки файлов: что именно случится с диском. */
export interface EditsConsequence {
  level: DangerLevel;
  note: string;
}

/**
 * Последствие пачки правок.
 *
 * Считаются ФАЙЛЫ, а не правки: «перезапишет 3 файла» человеку понятнее, чем
 * «12 правок», и правильный вопрос при решении — сколько мест пострадает, если
 * откатывать руками.
 */
export function editsConsequence(paths: readonly string[]): EditsConsequence {
  const unique = [...new Set(paths)];
  if (unique.length === 0) return { level: 'safe', note: 'ничего не изменится' };
  return {
    level: 'writes',
    note: unique.length === 1 ? `перезапишет 1 файл: ${unique[0]}` : `перезапишет файлов: ${unique.length}`,
  };
}
