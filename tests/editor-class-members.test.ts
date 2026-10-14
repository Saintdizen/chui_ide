import { describe, expect, it } from 'vitest';
import { classMembers, memberAccessAt, membersOf, receiverType } from '../src/renderer/editor/complete/member-access';

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
    expect(memberAccessAt('self.Elements.ba', 16)).toEqual({ receiver: 'Elements', prefix: 'ba', replaces: 2 });
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
