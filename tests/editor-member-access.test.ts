import { describe, expect, it } from 'vitest';
import {
  importsOf,
  isSelfReceiver,
  memberAccessAt,
  membersOf,
  membersOfPath,
  selfMembers,
} from '../src/renderer/editor/complete/member-access';

/**
 * Доступ к члену: подсказка после точки показывает имена объекта, а не слова файла.
 * Здесь проверяется распознавание места (`this.#di` → объект `this`, начало `#di`) и
 * запасной разбор членов из текста — тот, что работает без языкового сервера.
 */
describe('memberAccessAt', () => {
  it('точка без набранного имени — членов ещё нет, но место уже member', () => {
    const access = memberAccessAt('this.', 5);
    expect(access).toEqual({ receiver: 'this', path: ['this'], prefix: '', replaces: 0 });
  });

  it('набранное после точки становится началом члена', () => {
    const access = memberAccessAt('this.#dia', 9);
    expect(access).toEqual({ receiver: 'this', path: ['this'], prefix: '#dia', replaces: 4 });
  });

  it('закрытое поле начинается с #', () => {
    expect(memberAccessAt('this.#', 6)?.prefix).toBe('#');
  });

  it('объект может быть любым именем', () => {
    expect(memberAccessAt('order.add', 9)?.receiver).toBe('order');
    expect(memberAccessAt('Styles.SIZE.', 12)?.receiver).toBe('SIZE');
  });

  it('не member: не после точки', () => {
    expect(memberAccessAt('const value = 1', 15)).toBeNull();
  });

  it('не member: у выражения нет имени', () => {
    expect(memberAccessAt('load().', 7)).toBeNull();
    expect(memberAccessAt('].', 2)).toBeNull();
  });

  it('не member: развёртка и дробное число', () => {
    expect(memberAccessAt('...rest', 7)).toBeNull();
    expect(memberAccessAt('1.', 2)).toBeNull();
    expect(memberAccessAt('2.5', 3)).toBeNull();
  });

  it('курсор за строкой не роняет разбор', () => {
    expect(memberAccessAt('this.a', 999)?.receiver).toBe('this');
  });
});

describe('isSelfReceiver', () => {
  it('this в JS/Java/C# и self/cls в Python — текущий объект', () => {
    expect(isSelfReceiver('this')).toBe(true);
    expect(isSelfReceiver('self')).toBe(true);
    expect(isSelfReceiver('cls')).toBe(true);
    expect(isSelfReceiver('order')).toBe(false);
  });
});

describe('selfMembers', () => {
  it('находит поля и методы класса из объявлений', () => {
    const members = selfMembers(
      ['class Dialog {', '  #dialog = null;', '  width = 0;', '  setWidth(value) { this.width = value; }', '}'].join(
        '\n',
      ),
    );
    const names = members.map((member) => member.name);
    expect(names).toContain('#dialog');
    expect(names).toContain('width');
    expect(names).toContain('setWidth');
    expect(members.find((m) => m.name === 'setWidth')?.kind).toBe('method');
    expect(members.find((m) => m.name === '#dialog')?.kind).toBe('field');
  });

  it('находит то, что заведено только присваиванием в конструкторе', () => {
    const members = selfMembers(
      ['class A {', '  constructor(android) {', '    this.#android = android;', '  }', '}'].join('\n'),
    );
    expect(members.map((member) => member.name)).toContain('#android');
  });

  it('Python: self и def', () => {
    const members = selfMembers(
      ['class A:', '    def __init__(self):', '        self.count = 0', '    def run(self):', '        pass'].join(
        '\n',
      ),
    );
    const names = members.map((member) => member.name);
    expect(names).toContain('count');
    expect(names).toContain('run');
  });

  it('повторов нет, а служебные слова за члены не считаются', () => {
    const members = selfMembers(['x = self.count', 'y = self.count', 'if self.ready'].join('\n'));
    const names = members.map((member) => member.name);
    expect(names.filter((name) => name === 'count')).toHaveLength(1);
    expect(names).not.toContain('if');
  });

  it('TS-поле без инициализатора — тоже член', () => {
    const members = selfMembers(['export class A {', '  private button: number;', '}'].join('\n'));
    expect(members.map((member) => member.name)).toContain('button');
  });
});

/**
 * Члены чужого класса: класс объявлен в соседнем файле, поэтому без сервера его
 * приходится искать по тексту — сначала в импортированных модулях, потом в том,
 * что эти модули реэкспортируют.
 */
describe('membersOf', () => {
  const elements = [
    'export class Elements {',
    '  static byId(id: string): HTMLElement { return null; }',
    '  static sum(): number { return 0; }',
    '}',
  ].join('\n');

  it('находит класс в первом же прочитанном файле', () => {
    const members = membersOf('Elements.byId()', 'Elements', [elements]);
    expect(members.map((member) => member.name)).toContain('byId');
  });

  it('не останавливается на файле, где класса нет', () => {
    // Так выглядит пачка импортов: «Icons» приехал из иконок, «Elements» — из элементов.
    // Раньше поиск брал первый кандидат, не находил класс и сдавался.
    const icons = 'export const Icons = { ok: 1 };';
    const members = membersOf('Elements.byId()', 'Elements', [icons, elements]);
    expect(members.map((member) => member.name)).toContain('byId');
  });

  it('не нашлось нигде — пусто, а не чужие члены', () => {
    expect(membersOf('Elements.byId()', 'Elements', ['export const Icons = 1;'])).toEqual([]);
  });
});

describe('importsOf', () => {
  it('знает, из какого модуля приехало имя', () => {
    const text = "import { Icons } from './icons';\nimport { Elements } from './elements';\n";
    expect(importsOf(text, 'Elements')).toEqual(['./elements']);
    expect(importsOf(text, 'Icons')).toEqual(['./icons']);
  });

  it('Python: from pkg.mod import Name', () => {
    expect(importsOf('from pkg.mod import Widget\n', 'Widget')).toEqual(['pkg.mod']);
  });

  it('имя ниоткуда не импортировано — пусто', () => {
    expect(importsOf("import { Icons } from './icons';\n", 'Elements')).toEqual([]);
  });

  it('реэкспорт из index.ts — тот же модуль-источник', () => {
    // Файл, найденный по импорту, часто только пересылает; шаг реэкспорта
    // (assistant.memberEntriesFollowingReexports) ищет по этому результату.
    const index = "export { Elements } from './elements';\nexport * from './icons';\n";
    expect(importsOf(index, 'Elements')).toEqual(['./elements']);
  });

  it('переименование при импорте: ищем по локальному имени', () => {
    expect(importsOf("import { Elements as El } from './elements';\n", 'El')).toEqual(['./elements']);
  });
});

describe('цепочка a.b.', () => {
  const TS = [
    'class Pg { host = ""; port = 5432; }',
    'class Db {',
    '  conn: Pg;',
    '  name = "";',
    '}',
    'class App {',
    '  db: Db;',
    '}',
  ].join('\n');

  it('приёмник — последнее звено, путь — все звенья', () => {
    const line = 'self.db.conn.';
    expect(memberAccessAt(line, line.length)).toEqual({
      receiver: 'conn',
      path: ['self', 'db', 'conn'],
      prefix: '',
      replaces: 0,
    });
  });

  it('одно звено — путь равен [receiver]', () => {
    expect(memberAccessAt('this.', 5)?.path).toEqual(['this']);
  });

  it('тип поля из аннотации ведёт к его классу: `db: Db` → члены Db', () => {
    expect(membersOfPath(TS, ['self', 'db'])?.map((entry) => entry.name)).toEqual(['conn', 'name']);
  });

  it('два шага подряд: `self.db.conn.` → члены Pg', () => {
    expect(membersOfPath(TS, ['self', 'db', 'conn'])?.map((entry) => entry.name)).toEqual(['host', 'port']);
  });

  it('порядок звеньев важен: `self.conn.db` никуда не ведёт', () => {
    expect(membersOfPath(TS, ['self', 'conn', 'db'])).toBeNull();
  });

  it('аннотация без `=` тоже поле: тип берётся из `db: Db;`', () => {
    // Класса Db в этом тексте нет — идти некуда. Появился он — звено разрешается.
    expect(membersOfPath('class A {\n  db: Db;\n}', ['self', 'db'])).toBeNull();
    const withDb = 'class A {\n  db: Db;\n}\nclass Db { x = 1; }';
    expect(membersOfPath(withDb, ['self', 'db'])?.map((entry) => entry.name)).toEqual(['x']);
  });
});
