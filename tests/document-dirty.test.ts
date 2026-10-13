import { describe, expect, it, vi } from 'vitest';
import { DocumentStore } from '../src/renderer/core/document-store';

/**
 * Событие о снятой «грязности».
 *
 * Пометку «не сохранён» рисуют вкладка и дерево, а она меняется БЕЗ смены текста:
 * файл записали или вернули к версии с диска. По событию смены текста (`onDidChange`)
 * это не узнать — текст тот же, ничего не выстрелит, и пометка останется висеть,
 * пока её случайно не перерисует что-то другое. Отдельное событие убирает эту
 * зависимость от слухов: сохранение — факт самого документа.
 */
describe('DocumentStore: смена «грязности»', () => {
  it('сохранение правленого документа сообщает о снятой пометке', () => {
    const store = new DocumentStore();
    const document = store.open('/p/a.ts', 'текст');
    const onDirty = vi.fn();
    store.onDidChangeDirty(onDirty);

    document.setText('правка', 'user');
    document.markSaved(1000);

    expect(document.dirty).toBe(false);
    expect(onDirty).toHaveBeenCalledWith(document);
  });

  it('перечитывание чистого документа молчит — дёргать интерфейс незачем', () => {
    const store = new DocumentStore();
    const document = store.open('/p/a.ts', 'текст');
    const onDirty = vi.fn();
    store.onDidChangeDirty(onDirty);

    document.markSaved(1000);

    expect(onDirty).not.toHaveBeenCalled();
  });

  it('событие приходит из store, а не из документа: подписчик знает и путь', () => {
    const store = new DocumentStore();
    const document = store.open('/p/a.ts', 'текст');
    const seen: string[] = [];
    store.onDidChangeDirty((changed) => seen.push(changed.path));

    document.setText('правка', 'user');
    document.markSaved(1000);

    expect(seen).toEqual(['/p/a.ts']);
  });
});
