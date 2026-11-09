import { createHash } from 'node:crypto';

/**
 * Сквозной счётчик повторов ответов инструментов.
 *
 * Зачем: внутри одного ответа повторы свёрнуты (`collapseRepeats`), но между
 * шагами их видно не было. А повторяются они постоянно: тот же `run_tests` по
 * тому же набору, тот же `terminal` после `cd` и без него, тот же `git status`
 * после чтения файла. Второй раз это уже тысячи символов за «ничего не
 * изменилось» — и, что хуже, модель начинает думать, что ей сообщили новое.
 *
 * Сворачиваем не первый повтор, а со второго подряд: однократное совпадение —
 * ещё шум случая, а третье подряд — уже стабильный ответ.
 */

/** Сколько символов ответа не пришлось отдать при повторе. */
export interface RepeatStats {
  /** Сколько раз ответ свернули в пометку. */
  readonly collapsed: number;
  /** Сколько символов ответов при этом не отдали. */
  readonly savedChars: number;
}

interface Remembered {
  readonly hash: string;
  readonly summary: string;
  /** Сколько раз подряд этот ответ повторился. */
  readonly times: number;
  readonly chars: number;
}

/** Храним не тексты, а отпечатки: ответ бывает на сотни килобайт. */
export class RepeatTracker {
  private readonly byKey = new Map<string, Remembered>();
  private collapsed = 0;
  private savedChars = 0;

  /** `limit` — сколько отпечатков помним: дальше вытесняем старые. */
  constructor(private readonly limit = 256) {}

  /**
   * Учесть ответ инструмента. `undefined` — ответ новый или другой, отдавать
   * его надо целиком. Строка — тот же ответ уже был: это пометка вместо текста.
   */
  note(key: string, text: string, summary: string): string | undefined {
    const hash = createHash('sha1').update(text).digest('hex');
    const previous = this.byKey.get(key);
    if (!previous || previous.hash !== hash) {
      this.remember(key, { hash, summary, times: 1, chars: text.length });
      return undefined;
    }
    const times = previous.times + 1;
    this.remember(key, { hash, summary, times, chars: previous.chars });
    // Первый повтор ещё отдаём: рядом с ним модель видит, что вызвала одно и то же
    // дважды. Со второго подряд — сворачиваем, но говорим, сколько было раз.
    if (times < 3) return undefined;
    this.collapsed += 1;
    this.savedChars += previous.chars;
    return (
      `Ответ тот же, что и в прошлый раз (третий подряд): ${summary}. ` +
      `Не повторяю ${previous.chars} символов — ничего не изменилось с прошлого вызова. ` +
      'Если ждёшь изменения, поменяй запрос или сначала поправь то, что смотришь.'
    );
  }

  private remember(key: string, value: Remembered): void {
    this.byKey.delete(key);
    this.byKey.set(key, value);
    // Вытеснение по порядку вставки: старые вызовы уже не повторятся.
    while (this.byKey.size > this.limit) {
      const oldest = this.byKey.keys().next().value;
      if (oldest === undefined) break;
      this.byKey.delete(oldest);
    }
  }

  /** Правка файла: «то же, что и в прошлый раз» больше не верно. */
  forget(prefix: string): void {
    for (const key of this.byKey.keys()) {
      if (key.startsWith(prefix)) this.byKey.delete(key);
    }
  }

  forgetAll(): void {
    this.byKey.clear();
  }

  stats(): RepeatStats {
    return { collapsed: this.collapsed, savedChars: this.savedChars };
  }
}
