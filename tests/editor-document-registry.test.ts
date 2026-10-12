import { describe, expect, it } from 'vitest';
import { DocumentStore } from '../src/renderer/core/document-store';
import { DocumentRegistry } from '../src/renderer/editor/host/document-registry';

/** Стенд: стор документов плюс реестр буферов поверх него. */
function setup() {
  const documents = new DocumentStore();
  const registry = new DocumentRegistry(documents);
  return { documents, registry };
}

describe('DocumentRegistry', () => {
  it('буфер создаётся из текста документа', () => {
    const { documents, registry } = setup();
    const document = documents.open('/p/a.ts', 'const a = 1;\n');
    const buffer = registry.resolve(document);
    expect(buffer.text).toBe('const a = 1;\n');
    expect(registry.get('/p/a.ts')).toBe(buffer);
  });

  it('буфер тот же при повторном обращении: файл в двух панелях — один текст', () => {
    const { documents, registry } = setup();
    const document = documents.open('/p/a.ts', 'текст');
    expect(registry.resolve(document)).toBe(registry.resolve(document));
  });

  it('текст документа разошёлся с буфером — буфер подтягивается', () => {
    const { documents, registry } = setup();
    const document = documents.open('/p/a.ts', 'старый');
    const buffer = registry.resolve(document);
    // Кто-то переписал документ программно, не трогая буфер.
    document.setText('новый', 'programmatic');
    expect(registry.resolve(document).text).toBe('новый');
    expect(registry.get('/p/a.ts')).toBe(buffer);
  });

  it('правки в буфере уходят в документ по push: так вкладка видит «грязность»', () => {
    const { documents, registry } = setup();
    const document = documents.open('/p/a.ts', 'abc');
    const buffer = registry.resolve(document);
    buffer.insert(3, 'def');

    expect(document.dirty).toBe(false);
    const changed = registry.push('/p/a.ts');
    expect(changed).toBe(true);
    expect(document.value).toBe('abcdef');
    expect(document.dirty).toBe(true);
  });

  it('push без изменений сообщает, что менять нечего', () => {
    const { documents, registry } = setup();
    const document = documents.open('/p/a.ts', 'abc');
    registry.resolve(document);
    expect(registry.push('/p/a.ts')).toBe(false);
  });

  it('push по неизвестному пути ничего не делает', () => {
    const { registry } = setup();
    expect(registry.push('/p/нет.ts')).toBe(false);
  });

  it('изменение с диска заменяет текст буфера целиком', () => {
    const { documents, registry } = setup();
    const document = documents.open('/p/a.ts', 'мой текст');
    const buffer = registry.resolve(document);
    buffer.insert(0, 'правка ');

    // Файл перечитали с диска (git checkout, внешний редактор).
    document.setText('из репозитория', 'disk');
    expect(buffer.text).toBe('из репозитория');
  });

  it('программное изменение документа доходит до буфера: так видят формат и правки агента', () => {
    const { documents, registry } = setup();
    const document = documents.open('/p/a.ts', 'текст');
    const buffer = registry.resolve(document);
    // Формат при сохранении и правки агента меняют документ мимо буфера — на экране
    // должен оказаться тот же текст, иначе редактор показывал бы старое.
    document.setText('после формата', 'programmatic');
    expect(buffer.text).toBe('после формата');
  });

  it('внешняя замена буфера сообщает слушателям: надо перерисовать вид', () => {
    const { documents, registry } = setup();
    const document = documents.open('/p/a.ts', 'текст');
    registry.resolve(document);

    const changed: string[] = [];
    registry.onDidChangeBuffer((path) => changed.push(path));
    document.setText('новый текст', 'programmatic');
    expect(changed).toEqual(['/p/a.ts']);
  });

  it('правка редактора (user) внешней заменой не считается: буфер уже такой', () => {
    const { documents, registry } = setup();
    const document = documents.open('/p/a.ts', 'abc');
    const buffer = registry.resolve(document);
    buffer.insert(3, 'def');

    const changed: string[] = [];
    registry.onDidChangeBuffer((path) => changed.push(path));
    registry.push('/p/a.ts');
    expect(changed).toEqual([]);
  });

  it('утилизация буфера сообщает слушателям', () => {
    const { documents, registry } = setup();
    const document = documents.open('/p/a.ts', 'текст');
    registry.resolve(document);

    const disposed: string[] = [];
    registry.onDidDispose((path) => disposed.push(path));
    registry.dispose('/p/a.ts');

    expect(disposed).toEqual(['/p/a.ts']);
    expect(registry.get('/p/a.ts')).toBeUndefined();
  });

  it('повторная утилизация ничего не сообщает', () => {
    const { documents, registry } = setup();
    registry.resolve(documents.open('/p/a.ts', 'текст'));
    const disposed: string[] = [];
    registry.onDidDispose((path) => disposed.push(path));
    registry.dispose('/p/a.ts');
    registry.dispose('/p/a.ts');
    expect(disposed).toEqual(['/p/a.ts']);
  });

  it('clear забывает все буферы', () => {
    const { documents, registry } = setup();
    registry.resolve(documents.open('/p/a.ts', 'один'));
    registry.resolve(documents.open('/p/b.ts', 'два'));
    expect(registry.paths()).toHaveLength(2);

    registry.clear();
    expect(registry.paths()).toHaveLength(0);
  });

  it('перечисление буферов отдаёт путь и текст', () => {
    const { documents, registry } = setup();
    registry.resolve(documents.open('/p/a.ts', 'один'));
    expect([...registry.entries()].map(([path]) => path)).toEqual(['/p/a.ts']);
  });
});
