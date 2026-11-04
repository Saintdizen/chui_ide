/**
 * Реестр документов своего редактора: путь → буфер текста.
 *
 * Это свой реестр документов вместо прежних моделей движка: текст
 * файла живёт в нашем `TextBuffer` (таблица кусков плюс индекс строк), а истиной о
 * содержимом остаётся `TextDocument` — тот же, что и раньше, им пользуется и ассистент,
 * и сохранение.
 *
 * Почему реестр общий, а не «буфер в редакторе». Один и тот же файл можно смотреть в двух
 * панелях сразу, и правка должна быть видна в обеих: значит, буфер один на путь, а не по
 * одному на панель. То же правило было у прежних моделей, и причина та же.
 *
 * Смена текста с ДИСКА обрабатывается здесь: файл перечитали (git checkout, внешний
 * редактор) — буфер заменяется целиком. Правки пользователя идут в обратную сторону,
 * из буфера в документ, и делает это хозяин редактора: реестр про ввод ничего не знает.
 *
 * Модуль чистый: ни DOM, ни движка. Поэтому его видно в тестах без окна.
 */

import type { TextDocument } from '../../core/document';
import type { DocumentStore } from '../../core/document-store';
import { Emitter } from '../../core/events';
import { EditHistory } from '../core/history';
import { TextBuffer } from '../core/text-buffer';

/**
 * Сколько закрытых файлов помнят историю отмены.
 *
 * История держится НЕ контроллером (он гибнет вместе с вкладкой), а реестром —
 * по пути. Закрыл вкладку и открыл снова — `Ctrl+Z` возвращает прежние правки,
 * пока файл не вытеснен из этого предела. 32 — как у соседей: дальше выгода
 * меньше стоимости памяти, а жест «закрыл и вернулся» живёт минуты, не часы.
 */
const HISTORY_RETENTION = 32;

export class DocumentRegistry {
  private readonly buffers = new Map<string, TextBuffer>();
  /**
   * История отмены по пути. Переживает `dispose` буфера: закрыл вкладку — правки
   * ещё можно вернуть. Порядок вставки в Map — порядок LRU: трогая запись, переставляем
   * её в конец, а вытесняем самую старую.
   */
  private readonly histories = new Map<string, EditHistory>();
  private readonly disposeEmitter = new Emitter<string>();
  /** Буфер файла утилизирован: слушатели снимают то, что по нему рисовали. */
  readonly onDidDispose = this.disposeEmitter.event;

  private readonly changeEmitter = new Emitter<string>();
  /**
   * Текст буфера заменили СНАРУЖИ (не правкой редактора): надо перерисовать вид.
   * Правка самого редактора идёт с меткой `user` и сюда не попадает.
   */
  readonly onDidChangeBuffer = this.changeEmitter.event;

  constructor(private readonly documents: DocumentStore) {
    // Правка редактора приходит с меткой `user` — в этом случае буфер УЖЕ такой,
    // синхронизировать нечего. Всё остальное (диск после перечтения, форматирование,
    // правки агента) приходит мимо буфера — его надо донести, иначе на экране
    // останется старый текст. Замена полная, а не частичная: источник правки мы
    // всё равно не видели, а полная замена надёжнее выдуманных диапазонов.
    this.documents.onDidChange(({ document, change }) => {
      if (change.source === 'user') return;
      const buffer = this.buffers.get(document.path);
      if (!buffer || buffer.text === document.value) return;
      buffer.replace(0, buffer.length, document.value);
      this.changeEmitter.fire(document.path);
    });
  }

  get(path: string): TextBuffer | undefined {
    return this.buffers.get(path);
  }

  entries(): IterableIterator<[string, TextBuffer]> {
    return this.buffers.entries();
  }

  /** Пути открытых буферов — для «сохранить всё» и обхода. */
  paths(): string[] {
    return [...this.buffers.keys()];
  }

  /**
   * Буфер документа: существующий либо созданный. Если текст документа разошёлся с
   * буфером (его переписали программно, не тронув буфер), буфер подтягивается —
   * иначе редактор показывал бы старый текст.
   */
  resolve(document: TextDocument): TextBuffer {
    const existing = this.buffers.get(document.path);
    if (existing) {
      if (existing.text !== document.value) existing.replace(0, existing.length, document.value);
      return existing;
    }

    const created = new TextBuffer(document.value);
    this.buffers.set(document.path, created);
    return created;
  }

  /**
   * Сказать документу, что в буфере новый текст. Возвращает `true`, если текст
   * действительно другой: по этому признаку хозяин редактора понимает, надо ли
   * обновлять вид и «грязность» вкладки.
   */
  push(path: string): boolean {
    const buffer = this.buffers.get(path);
    const document = this.documents.get(path);
    if (!buffer || !document) return false;
    return document.setText(buffer.text, 'user');
  }

  /**
   * История отмены файла — одна на путь, живущая дольше вкладки.
   *
   * Именно здесь, а не в контроллере: `EditorController` создаётся на открытие
   * вкладки и умирает на закрытие, а человек ждёт, что вернувшийся файл сохранит
   * `Ctrl+Z`. Предел `limit` применяется только к новой истории; у существующей он
   * уже задан при создании (смена предела на лету не нужна и путана).
   */
  historyFor(path: string, limit?: number): EditHistory {
    const existing = this.histories.get(path);
    if (existing) {
      // Тронули — запись свежая: переставляем в конец (LRU).
      this.histories.delete(path);
      this.histories.set(path, existing);
      return existing;
    }
    const created = new EditHistory(limit);
    this.histories.set(path, created);
    if (this.histories.size > HISTORY_RETENTION) {
      const oldest = this.histories.keys().next().value;
      if (oldest !== undefined) this.histories.delete(oldest);
    }
    return created;
  }

  /** Забыть историю файла навсегда: файл удалён или переименован, отменять нечего. */
  forgetHistory(path: string): void {
    this.histories.delete(path);
  }

  /** Утилизировать буфер файла. Слушатели `onDidDispose` снимут своё по этому пути. */
  dispose(path: string): void {
    if (!this.buffers.delete(path)) return;
    // ИСТОРИЮ ЗДЕСЬ НЕ ЧИСТИМ: закрытие вкладки не повод терять отмену. Живёт до
    // вытеснения из `histories` (см. `historyFor`) или явного `forgetHistory`.
    this.disposeEmitter.fire(path);
  }

  /** Забыть всё: закрытие проекта. */
  clear(): void {
    for (const path of [...this.buffers.keys()]) this.dispose(path);
    this.histories.clear();
  }
}
