import { describe, expect, it } from 'vitest';
import { DocumentStore } from '../src/renderer/core/document-store';
import { OpenEditors } from '../src/renderer/core/open-editors';

/**
 * Вкладки: предпросмотр (вкладка «на посмотреть», которую вытесняет следующая такая
 * же) и закрепление (вкладка «насовсем»). Проверяется модель — без DOM: именно она
 * решает, что открыто, что закреплено и какая вкладка активна.
 */
function setup() {
  const documents = new DocumentStore();
  const open = new OpenEditors(documents);
  return { documents, open };
}

describe('предпросмотр', () => {
  it('вторая вкладка-предпросмотр вытесняет первую', () => {
    const { documents, open } = setup();
    open.open(documents.open('/a.ts', 'a'), { preview: true });
    open.open(documents.open('/b.ts', 'b'), { preview: true });
    expect(open.paths).toEqual(['/b.ts']);
    // Вытесненный документ закрывается — иначе хранилище копило бы брошенные буферы.
    expect(documents.get('/a.ts')).toBeUndefined();
    expect(open.isPreview('/b.ts')).toBe(true);
  });

  it('предпросмотр встаёт на место прежнего, а не в конец', () => {
    const { documents, open } = setup();
    open.open(documents.open('/a.ts', 'a'));
    open.open(documents.open('/m.ts', 'm'), { preview: true });
    open.open(documents.open('/b.ts', 'b'));
    // Порядок: a, m(предпросмотр), b. Замена предпросмотра сохраняет его место.
    open.open(documents.open('/n.ts', 'n'), { preview: true });
    expect(open.paths).toEqual(['/a.ts', '/n.ts', '/b.ts']);
  });

  it('открытие насовсем снимает метку предпросмотра', () => {
    const { documents, open } = setup();
    const a = documents.open('/a.ts', 'a');
    open.open(a, { preview: true });
    open.open(a);
    expect(open.isPreview('/a.ts')).toBe(false);
  });

  it('правка делает вкладку постоянной: файл стал изменённым', () => {
    const { documents, open } = setup();
    const a = documents.open('/a.ts', 'a');
    open.open(a, { preview: true });
    a.setText('правка', 'user');
    expect(open.isPreview('/a.ts')).toBe(false);
  });

  it('закреплённую вкладку предпросмотр не вытесняет', () => {
    const { documents, open } = setup();
    open.open(documents.open('/a.ts', 'a'));
    open.pin('/a.ts');
    open.open(documents.open('/b.ts', 'b'), { preview: true });
    open.open(documents.open('/c.ts', 'c'), { preview: true });
    expect(open.paths).toEqual(['/a.ts', '/c.ts']);
    expect(open.isPinned('/a.ts')).toBe(true);
  });
});

describe('закрепление', () => {
  it('закрепление снимает метку предпросмотра', () => {
    const { documents, open } = setup();
    open.open(documents.open('/a.ts', 'a'), { preview: true });
    open.pin('/a.ts');
    expect(open.isPreview('/a.ts')).toBe(false);
    expect(open.isPinned('/a.ts')).toBe(true);
  });

  it('закрытие вкладки снимает и закрепление', () => {
    const { documents, open } = setup();
    open.open(documents.open('/a.ts', 'a'));
    open.pin('/a.ts');
    open.close('/a.ts');
    expect(open.isPinned('/a.ts')).toBe(false);
    expect(open.has('/a.ts')).toBe(false);
  });
});

describe('закрытие других', () => {
  it('оставляет только указанную и закреплённые', () => {
    const { documents, open } = setup();
    open.open(documents.open('/a.ts', 'a'));
    open.open(documents.open('/b.ts', 'b'));
    open.open(documents.open('/c.ts', 'c'));
    open.open(documents.open('/keep.ts', 'k'));
    open.pin('/b.ts');
    open.closeOthers('/keep.ts');
    expect([...open.paths].sort()).toEqual(['/b.ts', '/keep.ts']);
    expect(open.active?.path).toBe('/keep.ts');
  });
});

describe('порядок использования', () => {
  it('вкладки помнят, когда их показывали: свежие впереди', () => {
    const { documents, open } = setup();
    open.open(documents.open('/a.ts', 'a'));
    open.open(documents.open('/b.ts', 'b'));
    open.activate('/a.ts');
    expect(open.recent).toEqual(['/a.ts', '/b.ts']);
  });

  it('шаг идёт к предыдущей по показу, а не к соседке по полосе', () => {
    const { documents, open } = setup();
    for (const name of ['a', 'b', 'c']) open.open(documents.open(`/${name}.ts`, name));
    // Показы: a, b, c, a. Полоса — a b c, а по порядку использования за a идёт c.
    open.activate('/a.ts');
    expect(open.cycleRecent(1)).toBe('/c.ts');
  });

  it('повторные нажатия идут дальше по кругу, а не прыгают туда-обратно', () => {
    const { documents, open } = setup();
    for (const name of ['a', 'b', 'c']) open.open(documents.open(`/${name}.ts`, name));
    open.activate('/a.ts');
    const first = open.cycleRecent(1);
    expect(first).toBe('/c.ts');
    open.activate('/c.ts');
    expect(open.cycleRecent(1)).toBe('/b.ts');
    open.activate('/b.ts');
    // Круг замкнулся — дальше снова свежая вкладка, а не та, откуда начали.
    expect(open.cycleRecent(1)).toBe('/a.ts');
  });

  it('обратный шаг заходит с другого конца круга', () => {
    const { documents, open } = setup();
    for (const name of ['a', 'b', 'c']) open.open(documents.open(`/${name}.ts`, name));
    open.activate('/a.ts');
    expect(open.cycleRecent(-1)).toBe('/b.ts');
  });

  it('закрытая во время перебора вкладка из снимка выпадает', () => {
    const { documents, open } = setup();
    for (const name of ['a', 'b', 'c']) open.open(documents.open(`/${name}.ts`, name));
    open.activate('/a.ts');
    expect(open.cycleRecent(1)).toBe('/c.ts');
    open.close('/c.ts');
    expect(open.cycleRecent(1)).toBe('/b.ts');
  });

  it('одной вкладки для перебора мало', () => {
    const { documents, open } = setup();
    open.open(documents.open('/a.ts', 'a'));
    expect(open.cycleRecent(1)).toBeNull();
  });

  it('отпущенная клавиша начинает перебор заново — со свежей вкладки', () => {
    const { documents, open } = setup();
    for (const name of ['a', 'b', 'c']) open.open(documents.open(`/${name}.ts`, name));
    open.activate('/a.ts');
    expect(open.cycleRecent(1)).toBe('/c.ts');
    open.activate('/c.ts');
    open.endRecentCycle();
    expect(open.cycleRecent(1)).toBe('/a.ts');
  });

  it('restoreRecent выбрасывает пути, которых нет среди вкладок', () => {
    const { documents, open } = setup();
    open.open(documents.open('/a.ts', 'a'));
    open.open(documents.open('/b.ts', 'b'));
    open.restoreRecent(['/gone.ts', '/a.ts', '/b.ts']);
    expect(open.recent).toEqual(['/a.ts', '/b.ts']);
  });
});
