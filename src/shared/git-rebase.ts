/**
 * Интерактивный rebase: список шагов и его проверка.
 *
 * `git rebase -i` открывает редактор со «списком дел» (todo): по строке на коммит,
 * вида `<действие> <хеш> <тема>`. Правит этот список человек — обычно чтобы
 * переставить коммиты, склеить (squash/fixup) или выбросить (drop). Мы делаем то же
 * самое, но своим окном: собранный список отдаём git через свой `GIT_SEQUENCE_EDITOR`
 * (см. `main/git/git.ts`), а здесь живут только данные и правила — их видно в тестах
 * без git и без Electron.
 *
 * Порядок элементов — тот, в котором коммиты пойдут в истории: сверху самый ранний.
 */

/** Что сделать с коммитом. Слова — из `git rebase -i`. */
export type RebaseAction =
  /** Оставить как есть. */
  | 'pick'
  /** Оставить, но переписать сообщение. */
  | 'reword'
  /** Оставить и остановиться, чтобы поправить сам коммит (`git rebase --continue`). */
  | 'edit'
  /** Склеить с предыдущим, сообщения соединить. */
  | 'squash'
  /** Склеить с предыдущим, сообщение предыдущего. */
  | 'fixup'
  /** Выбросить коммит. */
  | 'drop';

/** Все действия в порядке показа в выпадающем списке. */
export const REBASE_ACTIONS: readonly RebaseAction[] = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'];

/** Один шаг: что сделать и с каким коммитом. */
export interface RebaseTodoItem {
  action: RebaseAction;
  /** Хеш коммита (короткий или полный). */
  commit: string;
  /** Тема коммита — только для показа, git её перезапишет. */
  subject: string;
  /** Новое сообщение — нужно для `reword`. */
  message?: string;
}

/** Человеческая подпись действия. */
export function rebaseActionLabel(action: RebaseAction): string {
  switch (action) {
    case 'pick':
      return 'оставить';
    case 'reword':
      return 'переписать сообщение';
    case 'edit':
      return 'остановиться и править';
    case 'squash':
      return 'склеить (сообщения вместе)';
    case 'fixup':
      return 'склеить (сообщение первого)';
    case 'drop':
      return 'выбросить';
  }
}

/** Короткое слово действия — для тесной колонки. */
export function rebaseActionShort(action: RebaseAction): string {
  switch (action) {
    case 'pick':
      return 'pick';
    case 'reword':
      return 'reword';
    case 'edit':
      return 'edit';
    case 'squash':
      return 'squash';
    case 'fixup':
      return 'fixup';
    case 'drop':
      return 'drop';
  }
}

/**
 * Список шагов в формате файла todo. Тема идёт после хеша — git читает её как
 * комментарий и перезаписывает своим текстом; нам она нужна, чтобы список было
 * видно глазами (и чтобы поймать расхождение при разборе).
 */
export function formatRebaseTodo(items: readonly RebaseTodoItem[]): string {
  return items.map((item) => `${rebaseActionShort(item.action)} ${item.commit} ${item.subject}`.trimEnd()).join('\n');
}

/**
 * Разбор файла todo: строки `<действие> <хеш> [тема]`. Пустые строки и строки-
 * комментарии (`#`) пропускаем: git и то и другое понимает как «не строка шага».
 */
export function parseRebaseTodo(text: string): RebaseTodoItem[] {
  const items: RebaseTodoItem[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const word = parts[0];
    const commit = parts[1];
    if (!word || !commit) continue;
    const action = (REBASE_ACTIONS as readonly string[]).includes(word) ? (word as RebaseAction) : 'pick';
    items.push({ action, commit, subject: parts.slice(2).join(' ') });
  }
  return items;
}

/**
 * Проверка списка перед запуском. Возвращает текст ошибки или `null`, если всё
 * можно исполнять. Так окно говорит о проблеме простыми словами, а не ловит
 * ругань git после запуска.
 */
export function validateRebaseTodo(items: readonly RebaseTodoItem[]): string | null {
  if (items.length === 0) return 'Нечего перестраивать: список коммитов пуст';
  for (const [index, item] of items.entries()) {
    if (!item.commit.trim()) return 'У коммита потерялся хеш';
    // Склейка присоединяется к ПРЕДЫДУЩЕМУ: у первого её нет — git такую строку отвергнет.
    if ((item.action === 'squash' || item.action === 'fixup') && index === 0) {
      return 'Склеить не с чем: первый коммит в списке не может быть squash или fixup';
    }
    if (item.action === 'reword' && !item.message?.trim()) {
      return 'Для «переписать сообщение» нужно новое сообщение';
    }
  }
  return null;
}
