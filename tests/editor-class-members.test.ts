import { describe, expect, it } from 'vitest';
import {
  classMembers,
  importsOf,
  memberAccessAt,
  membersOf,
  receiverType,
} from '../src/renderer/editor/complete/member-access';

/**
 * Члены НАЗВАННОГО класса из текста файла — то, чего раньше не было: после
 * `self.Elements.` человек ждёт членов вложенного класса, а не слов файла.
 * Случай взят с живого проекта (страницы на Selenium).
 */
describe('classMembers', () => {
  const page = [
    'class BasePage:',
    '    def open(self, url=None):',
    '        self.browser.open(url)',
    '',
    'class MosMain(BasePage):',
    '    class Elements:',
    '        lk_button = Element("//*[text()=\'Войти\']/..")',
    '        back_to_old_design = Element("//*[contains(normalize-space(text()))]")',
    '        login_field = TextInput("login")',
    '',
    '    def enter_lk(self):',
    '        self.Elements.back_to_old_design.click()',
  ].join('\n');

  it('находит поля класса, в том числе вложенного', () => {
    const names = classMembers(page, 'Elements').map((member) => member.name);
    expect(names).toContain('lk_button');
    expect(names).toContain('back_to_old_design');
    expect(names).toContain('login_field');
  });

  it('тело метода за члены класса не берёт', () => {
    // `browser.open(url)` — строка внутри метода open(), а не член класса.
    const names = classMembers(page, 'BasePage').map((member) => member.name);
    expect(names).toContain('open');
    expect(names).not.toContain('browser');
  });

  it('методы отличаются от полей, чужой класс пуст', () => {
    const members = classMembers(page, 'MosMain');
    expect(members.find((member) => member.name === 'enter_lk')?.kind).toBe('method');
    expect(classMembers(page, 'НетакогоКласса')).toEqual([]);
  });

  it('плоский TS-класс: члены на отступе заголовка', () => {
    // Так пишут почти весь TS/TSX: тело без лишнего сдвига. Раньше цикл обрывался
    // на первом же члене (отступ не больше отступа заголовка) и класс был пуст.
    const flat = [
      'class Repo {',
      'private db: Db;',
      '  pool: Map<string, Connection>;',
      '  find(): void {',
      '    return this.find();',
      '  }',
      '}',
    ].join('\n');
    const members = classMembers(flat, 'Repo');
    expect(members.map((member) => member.name)).toEqual(['db', 'pool', 'find']);
    expect(members.find((member) => member.name === 'db')?.type).toBe('Db');
    expect(members.find((member) => member.name === 'find')?.kind).toBe('method');
  });

  it('модификаторы доступа не мешают имени и типу', () => {
    const text = [
      'class A {',
      '  private readonly conn: Conn;',
      '  public async load(): Promise<void> {}',
      '  protected static make(): void {}',
      '}',
    ].join('\n');
    const members = classMembers(text, 'A');
    expect(members.find((member) => member.name === 'conn')?.type).toBe('Conn');
    expect(members.find((member) => member.name === 'load')?.kind).toBe('method');
    expect(members.find((member) => member.name === 'make')?.kind).toBe('method');
  });

  it('get/set — модификатор с пробелом, но имя метода get() остаётся именем', () => {
    const text = [
      'class A {',
      '  get size(): number { return 1; }',
      '  set size(v: number) {}',
      "  get(): string { return ''; }",
      '}',
    ].join('\n');
    const names = classMembers(text, 'A').map((member) => member.name);
    expect(names).toContain('size');
    expect(names).toContain('get');
  });

  it('плоский класс не съедает следующее объявление', () => {
    // Без новой границы (см. `sameLevelDeclaration`) плоский класс тянул бы всё вниз.
    const text = ['class Repo {', '  db: Db;', '}', 'export class Other {', '  x: string;', '}'].join('\n');
    expect(classMembers(text, 'Repo').map((member) => member.name)).toEqual(['db']);
    expect(classMembers(text, 'Other').map((member) => member.name)).toEqual(['x']);
  });
});

describe('membersOf', () => {
  it('self — члены текущего объекта, иное имя — члены класса с этим именем', () => {
    const text = ['class A:', '    x = 1', '    def run(self):', '        self.x = 2'].join('\n');
    expect(membersOf(text, 'self').map((member) => member.name)).toContain('x');
    expect(membersOf(text, 'A').map((member) => member.name)).toContain('x');
  });

  it('доступ к вложенному классу даёт его члены', () => {
    const text = ['class P:', '    class Elements:', '        back_to_old_design = 1'].join('\n');
    expect(membersOf(text, 'Elements').map((member) => member.name)).toContain('back_to_old_design');
  });
});

describe('вложенный доступ в строке', () => {
  it('self.Elements.ba распознаётся как приёмник Elements', () => {
    expect(memberAccessAt('self.Elements.ba', 16)).toEqual({
      receiver: 'Elements',
      path: ['self', 'Elements'],
      prefix: 'ba',
      replaces: 2,
    });
  });
});

/**
 * Многоуровневое вложение: `self.browser.driver.` — приёмник не `self` и не имя класса,
 * а ПОЛЕ, у которого есть тип. Раньше по такому приёмнику членов не находилось вовсе,
 * и приходилось полагаться только на сервер: если он отвечал не про то место (текст
 * ещё не доехал), вместо `driver` показывался мусор из области видимости.
 * Случай взят с живого проекта: страница на Selenium, `browser` — драйвер.
 */
describe('многоуровневое вложение: члены по типу приёмника', () => {
  const page = [
    'class WebDriver:',
    '    def find_elements_by_xpath(self, xpath: str):',
    '        return []',
    '',
    '    def quit(self):',
    '        pass',
    '',
    'class BaseWebDriver(WebDriver):',
    '    driver = WebDriver()',
    '',
    'class BasePage:',
    '    def __init__(self, browser: BaseWebDriver):',
    '        self.browser = browser',
    '',
    '    def get_links(self, xpath: str):',
    '        self.browser.dri',
  ].join('\n');

  it('self.browser. — члены типа поля (аннотация параметра)', () => {
    const names = membersOf(page, 'browser').map((member) => member.name);
    // `driver` — член класса драйвера, а не метод страницы.
    expect(names).toContain('driver');
    expect(names).not.toContain('get_links');
  });

  it('тип берётся из аннотации поля и из присваивания экземпляра', () => {
    const annotated = ['class Page:', '    browser: BaseWebDriver = None'].join('\n');
    expect(receiverType(annotated, 'browser')).toBe('BaseWebDriver');

    const constructed = ['class Page:', '    def __init__(self):', '        self.browser = BaseWebDriver()'].join('\n');
    expect(receiverType(constructed, 'browser')).toBe('BaseWebDriver');

    // Присваивание обычной переменной типом не считается: `browser` тут — не класс.
    const aliased = ['class Page:', '    def __init__(self, other):', '        self.browser = other'].join('\n');
    expect(receiverType(aliased, 'browser')).toBeNull();
  });

  it('имя КЛАССА остаётся важнее типа: Elements. — его члены', () => {
    const text = [
      'class Page:',
      '    class Elements:',
      '        lk_button = 1',
      '    def __init__(self):',
      '        self.Elements = Elements()',
    ].join('\n');
    expect(membersOf(text, 'Elements').map((member) => member.name)).toContain('lk_button');
  });
});

/**
 * Класс, объявленный в СОСЕДНЕМ файле и ввезённый импортом: в тексте открытого
 * файла его тела нет, и по одному `text` членов не бывает. Раньше члены такого
 * класса не показывались вовсе — ни сервером (он ещё не ответил), ни запасным
 * путём (он смотрел только в открытый файл). Теперь второй текст передаётся
 * в `elsewhere`.
 */
describe('члены импортированного класса', () => {
  const page = [
    "import { Elements } from './elements';",
    '',
    'export class Page {',
    '  constructor() {',
    '    this.el = new Elements();',
    '  }',
    '}',
  ].join('\n');

  const elements = [
    'export class Elements {',
    '  lkButton: number;',
    '  backToOldDesign = Element(\'//*[@id="old"]\');',
    '  click(): void {}',
    '}',
  ].join('\n');

  it('membersOf ищет класс и по имени приёмника, и по типу поля', () => {
    const byName = membersOf(page, 'Elements', [elements]).map((member) => member.name);
    expect(byName).toContain('lkButton');
    expect(byName).toContain('click');

    // `this.el.` — приёмник `el`, тип `Elements` тоже объявлен в другом файле.
    const byType = membersOf(page, 'el', [elements]).map((member) => member.name);
    expect(byType).toContain('lkButton');
  });

  it('без второго текста членов нет — виноват не разбор, а отсутствие текста', () => {
    expect(membersOf(page, 'Elements')).toEqual([]);
  });

  it('свой класс ближе чужого: тот же класс в открытом файле побеждает', () => {
    const local = ['class Elements {', '  own = 1;', '}', page].join('\n');
    const names = membersOf(local, 'Elements', [elements]).map((member) => member.name);
    expect(names).toContain('own');
    expect(names).not.toContain('lkButton');
  });
});

/**
 * Спецификаторы импорта по имени: по ним ищется файл с телом класса.
 * Разбираются оба стиля — JS/TS (`import … from '…'`) и Python (`from pkg.mod import X`).
 */
describe('importsOf', () => {
  it('JS/TS: именованный и прямой импорт', () => {
    expect(importsOf("import { A, Elements } from './elements';", 'Elements')).toContain('./elements');
    expect(importsOf("import Elements from './elements';", 'Elements')).toContain('./elements');
  });

  it('Python: from pkg.mod import X', () => {
    expect(importsOf('from pages.elements import Elements', 'Elements')).toContain('pages.elements');
  });

  it('имя из другого импорта не путается с искомым', () => {
    expect(importsOf("import { Other } from './other';", 'Elements')).toEqual([]);
  });
});
