import type { ReviewSide, ReviewThread } from '../../shared/review';
import {
  addComment,
  addThread,
  editLastComment,
  makeComment,
  makeThread,
  removeThread,
  reviewCounts,
  sanitizeReview,
  setResolved,
  threadsAt,
  threadsForFile,
  REVIEW_LOCAL_AUTHOR,
} from '../../shared/review';
import { Emitter } from './events';
import type { RpcClient } from './rpc';
import type { WorkspaceModel } from './workspace-model';

/**
 * Замечания к коду в текущем проекте.
 *
 * Источник истины — здесь: список правится чистыми функциями (`shared/review.ts`), а
 * main только хранит его в `.chui_ide/review.json` (одним файлом на проект). Так
 * замечания переживают перезапуск и едут вместе с проектом, а вся логика тредов
 * остаётся проверяемой без ФС.
 *
 * Смена рабочей папки перечитывает список: замечания одного проекта к другому не
 * относятся. Запись идёт сразу за правкой — замечаний немного, и терять их нельзя.
 */
export class ReviewModel {
  private threads: ReviewThread[] = [];
  /** Папка, к которой относятся загруженные замечания: `null` — проект не открыт. */
  private loadedRoot: string | null = null;

  private readonly emitter = new Emitter<readonly ReviewThread[]>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly rpc: RpcClient,
    private readonly workspace: WorkspaceModel,
  ) {
    workspace.onDidChange(() => void this.reload());
    void this.reload();
  }

  get all(): readonly ReviewThread[] {
    return this.threads;
  }

  /** Замечания файла в порядке строк. */
  forFile(path: string): ReviewThread[] {
    return threadsForFile(this.threads, path);
  }

  /** Замечания у строки одной стороны сравнения. */
  at(path: string, side: ReviewSide, line: number): ReviewThread[] {
    return threadsAt(this.threads, path, side, line);
  }

  /** Сколько открыто, решено и сколько всего сообщений — для подписи в шапке. */
  counts(): { open: number; resolved: number; comments: number } {
    return reviewCounts(this.threads);
  }

  /** Перечитать замечания проекта. */
  async reload(): Promise<void> {
    const root = this.workspace.root;
    if (!root) {
      this.threads = [];
      this.loadedRoot = null;
      this.emitter.fire(this.threads);
      return;
    }
    try {
      const threads = sanitizeReview(await this.rpc.request('review.load'));
      // Пока грузили, могли открыть другой проект: тогда ответ уже не к месту.
      if (root !== this.workspace.root) return;
      this.threads = threads;
      this.loadedRoot = root;
    } catch {
      // Хранилище недоступно — просто нет замечаний, а не отказ открытия проекта.
      this.threads = [];
      this.loadedRoot = root;
    }
    this.emitter.fire(this.threads);
  }

  /** Замечание к строке: новый тред с первым сообщением. Возвращает его id. */
  add(path: string, side: ReviewSide, line: number, anchor: string, text: string): string | null {
    if (text.trim() === '') return null;
    const thread = makeThread(path, side, line, anchor, text, REVIEW_LOCAL_AUTHOR);
    this.apply(addThread(this.threads, thread));
    return thread.id;
  }

  /** Ответ в существующем треде. */
  reply(id: string, text: string): void {
    if (text.trim() === '') return;
    this.apply(addComment(this.threads, id, makeComment(text, REVIEW_LOCAL_AUTHOR)));
  }

  /** Поправить последнее сообщение треда (опечатку в своём замечании). */
  editComment(id: string, text: string): void {
    this.apply(editLastComment(this.threads, id, text));
  }

  /** Пометить тред решённым или снова открытым. */
  resolve(id: string, resolved: boolean): void {
    this.apply(setResolved(this.threads, id, resolved));
  }

  /** Удалить тред целиком. */
  remove(id: string): void {
    this.apply(removeThread(this.threads, id));
  }

  /** Убрать все решённые треды файла: после вычитки их держать незачем. */
  clearResolved(path: string): void {
    const next = this.threads.filter((thread) => !(thread.path === path && thread.resolved));
    if (next.length !== this.threads.length) this.apply(next);
  }

  /**
   * Применить правку списка: сразу показать и записать. Пишем только когда проект
   * открыт и загружен именно он — иначе правка ушла бы не в тот проект.
   */
  private apply(next: readonly ReviewThread[]): void {
    this.threads = [...next];
    this.emitter.fire(this.threads);
    const root = this.workspace.root;
    if (!root || this.loadedRoot !== root) return;
    void this.rpc.request('review.save', { threads: this.threads }).catch(() => undefined);
  }
}
