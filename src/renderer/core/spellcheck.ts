/**
 * Проверка орфографии в renderer: словарь системы, слова человека и пропущенное.
 *
 * Модель — одна на приложение, а не на панель: словарь у всех панелей общий, и
 * пополнение его словом где-то в одной панели должно снять отметку во всех. Здесь
 * три множества и одно событие об изменении; нарезка текста на слова и проверка
 * живут в `shared/spellcheck.ts` (чистая логика), а как это рисуется — дело панели.
 *
 * Словарь системы приходит из main (в песочнице renderer файлов не читает); слова
 * человека хранятся в настройках; пропуск действует, пока открыто окно, — как в других
 * редакторах: «не исправлять это здесь» не должно тянуться в следующий запуск.
 *
 * Слова проекта — четвёртый слой, но живёт он в словаре человека и отделён там по
 * пометке (см. `addUserWord`): одно и то же слово в одном проекте — термин, в другом —
 * опечатка, и держать его в общих настройках значило бы тащить чужие имена за собой.
 */

import { SpellDictionary } from '../../shared/spellcheck';
import { Emitter } from './events';

export class SpellCheck {
  /** Словарь системы (из файла, найденного в main). Пуст, пока не загрузили. */
  private system = new SpellDictionary();
  /** Слова человека — хранятся в настройках и переживают перезапуск. */
  private user = new SpellDictionary();
  /** Слова этого проекта: термины и имена из его кода, а не из всего мира. */
  private project = new SpellDictionary();
  /** Пропущенные на сеанс: в словарь не пишем, живут до закрытия окна. */
  private readonly ignored = new Set<string>();

  private readonly emitter = new Emitter<void>();
  /** Словарь изменился: прежние отметки могли устареть — панели перепроверяют текст. */
  readonly onDidChange = this.emitter.event;

  /** Знает ли модель хоть слово — без словаря проверять нечего. */
  get ready(): boolean {
    return this.system.size > 0 || this.user.size > 0 || this.project.size > 0;
  }

  /** Заменить словарь системы (пришёл из main по RPC). */
  setDictionary(words: readonly string[]): void {
    this.system = new SpellDictionary(words);
    this.emitter.fire();
  }

  /** Заменить слова человека (пришли из настроек). */
  setUserWords(words: readonly string[]): void {
    this.user = new SpellDictionary(words);
    this.emitter.fire();
  }

  /**
   * Заменить слова проекта. Пустой список — проект сменился или своих слов нет;
   * прежние при этом снимаются, иначе чужие термины пережили бы переход к другому проекту.
   */
  setProjectWords(words: readonly string[]): void {
    this.project = new SpellDictionary(words);
    this.emitter.fire();
  }

  /** Сколько слов знает проект: столько покажем в настройках и меню. */
  get projectSize(): number {
    return this.project.size;
  }

  /** Запомнить слово как «своё» во всём приложении. */
  addUserWord(word: string): void {
    this.user.add(word);
    this.emitter.fire();
  }

  /** Запомнить слово как термин этого проекта. */
  addProjectWord(word: string): void {
    this.project.add(word);
    this.emitter.fire();
  }

  /** Пропустить слово на этот сеанс, в словарь не записывая. */
  ignore(word: string): void {
    this.ignored.add(word.toLowerCase());
    this.emitter.fire();
  }

  /** Знает ли слово кто-нибудь: пропущенное, своё, слова проекта или системы. */
  knows(word: string): boolean {
    const value = word.toLowerCase();
    if (this.ignored.has(value)) return true;
    return this.user.has(value) || this.project.has(value) || this.system.has(value);
  }

  /**
   * Подсказки-замены для слова с опечаткой. Свои и проектные идут вперёд системных: то,
   * что человек внёс сам (или что лежит в его проекте), ему и ближе. Дубли схлопываются.
   */
  suggest(word: string, limit = 5): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const candidate of [
      ...this.user.suggest(word, limit),
      ...this.project.suggest(word, limit),
      ...this.system.suggest(word, limit),
    ]) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      out.push(candidate);
      if (out.length >= limit) break;
    }
    return out;
  }
}
