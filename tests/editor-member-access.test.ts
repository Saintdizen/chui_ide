import { describe, expect, it } from 'vitest';
import { isSelfReceiver, memberAccessAt, selfMembers } from '../src/renderer/editor/complete/member-access';

/**
 * Доступ к члену: подсказка после точки показывает имена объекта, а не слова файла.
 * Здесь проверяется распознавание места (`this.#di` → объект `this`, начало `#di`) и
 * запасной разбор членов из текста — тот, что работает без языкового сервера.
 */
describe('memberAccessAt', () => {
  it('точка без набранного имени — членов ещё нет, но место уже member', () => {
    const access = memberAccessAt('this.', 5);
    expect(access).toEqual({ receiver: 'this', prefix: '', replaces: 0 });
  });

  it('набранное после точки становится началом члена', () => {
    const access = memberAccessAt('this.#dia', 9);
    expect(access).toEqual({ receiver: 'this', prefix: '#dia', replaces: 4 });
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
});
