// biome-ignore-all lint/suspicious/noExplicitAny: мини-DOM — заглушка, у которой тип
// намеренно шире настоящего: дырка в заглушке должна падать сразу, а не молча
// отдавать undefined. Вне этого файла такие типы не нужны.

/**
 * Мини-DOM для тестов UI.
 *
 * В проекте нет jsdom (тянуть его ради нескольких виждетов не хочется), а тесты на
 * панели и виждеты писать надо: из 95 модулей `renderer/ui` тест имел десяток. Здесь
 * ровно тот набор свойств, которым пользуются `ui/dom.ts` и виждеты: дерево, классы,
 * атрибуты, `append`/`prepend`/`remove`, поиск по `.class` и метрики элемента.
 *
 * Настоящий `HTMLElement` не воспроизводится сознательно: если код залезет в то,
 * чего здесь нет, тест упадёт и покажет, какой метод надо добавить.
 */

export interface MiniNode {
  tagName: string;
  className: string;
  id: string;
  textContent: string;
  childNodes: MiniNode[];
  parentNode: MiniNode | null;
  [key: string]: any;
}

function textNode(text: string): any {
  return { nodeType: 3, textContent: text, parentNode: null };
}

function defineTree(node: any): void {
  const define = (name: string, get: () => unknown, set?: (value: any) => void) =>
    Object.defineProperty(node, name, { configurable: true, enumerable: true, get, set });

  define('firstChild', () => node.childNodes[0] ?? null);
  define('lastChild', () => node.childNodes[node.childNodes.length - 1] ?? null);
  define('firstElementChild', () => node.children[0] ?? null);
  define('parentElement', () => node.parentNode);
  define(
    'textContent',
    () =>
      node.childNodes.length === 0 ? node._text : node.childNodes.map((child: any) => child.textContent ?? '').join(''),
    (value: string) => {
      node._text = String(value);
      node.childNodes = [];
      node.children = [];
    },
  );
}

function defineTreeOps(node: any): void {
  node.appendChild = (child: any) => {
    child.parentNode = node;
    node.childNodes.push(child);
    node.children.push(child);
    return child;
  };
  node.append = (...kids: any[]) => {
    for (const kid of kids) node.appendChild(typeof kid === 'string' ? textNode(kid) : kid);
  };
  node.prepend = (...kids: any[]) => {
    for (const kid of [...kids].reverse()) node.insertBefore(kid, node.childNodes[0] ?? null);
  };
  node.insertBefore = (child: any, ref: any) => {
    const at = node.childNodes.indexOf(ref);
    child.parentNode = node;
    if (at < 0) node.childNodes.push(child);
    else node.childNodes.splice(at, 0, child);
    node.children = node.childNodes.slice();
    return child;
  };
  node.removeChild = (child: any) => {
    node.childNodes = node.childNodes.filter((item: any) => item !== child);
    node.children = node.childNodes.slice();
    child.parentNode = null;
    return child;
  };
  node.remove = () => node.parentNode?.removeChild(node);
  node.replaceChildren = (...kids: any[]) => {
    node.childNodes = [];
    node.children = [];
    for (const kid of kids) node.appendChild(kid);
  };
  node.replaceWith = () => {};
  node.after = () => {};
  node.before = () => {};
}

function defineEvents(node: any): void {
  node.addEventListener = (type: string, handler: (event: unknown) => void) => {
    (node.handlers[type] ??= []).push(handler);
  };
  node.removeEventListener = (type: string, handler: (event: unknown) => void) => {
    node.handlers[type] = (node.handlers[type] ?? []).filter((item: any) => item !== handler);
  };
  // `dispatchEvent` зовёт обработчики этого типа: тесту нужно нажимать и набирать,
  // а не только вешать обработчики. У настоящего DOM событие всплывает — здесь
  // достаточно целевого узла, виждеты слушают те элементы, к которым привязаны.
  //
  // Событие отдаём САМОМУ объекту, а не копии: `preventDefault` в обработчике
  // должен быть виден тесту (проверяем, что редактор гасит зум браузера).
  node.dispatchEvent = (event: { type: string }) => {
    for (const handler of node.handlers[event.type] ?? []) handler(Object.assign(event, { target: node }));
    return true;
  };
  // `click` зовёт обработчики: тесту нужно нажимать, а не только вешать.
  node.click = () => {
    for (const handler of node.handlers.click ?? []) {
      handler({ target: node, preventDefault() {}, stopPropagation() {} });
    }
  };
}

function defineLookup(node: any): void {
  node.setAttribute = (key: string, value: string) => {
    node.attrs[key] = String(value);
  };
  node.removeAttribute = (key: string) => {
    delete node.attrs[key];
  };
  node.getAttribute = (key: string) => node.attrs[key] ?? null;
  node.hasAttribute = (key: string) => key in node.attrs;
  // Булевы атрибуты в настоящем DOM отражаются в свойстве: `h()` ставит `hidden`
  // пустым атрибутом, и виждеты читают `element.hidden`. Без этого проверка
  // «панель скрыта» смотрела бы на пустое свойство и всегда была бы неверной.
  Object.defineProperty(node, 'hidden', {
    configurable: true,
    get: () => node.attrs.hidden !== undefined,
    set: (value: boolean) => {
      if (value) node.attrs.hidden = '';
      else delete node.attrs.hidden;
    },
  });
  node.querySelector = (selector: string) => find(node, selector);
  node.querySelectorAll = (selector: string) => {
    const found: any[] = [];
    // Класс ищется и по `className`, и по `classList`: `h()` пишет `class` в
    // атрибут и в `className`, а виждеты добавляют классы через `classList`.
    walk(node, (item) => {
      if (matchesSelector(item, selector)) found.push(item);
    });
    return found;
  };
  node.getElementsByClassName = (name: string) => node.querySelectorAll(`.${name}`);
  node.closest = (selector: string) => {
    let cursor: any = node;
    while (cursor) {
      if (matchesSelector(cursor, selector)) return cursor;
      cursor = cursor.parentNode;
    }
    return null;
  };
  node.contains = (other: any) => {
    let cursor: any = other;
    while (cursor) {
      if (cursor === node) return true;
      cursor = cursor.parentNode;
    }
    return false;
  };
  node.focus = () => {};
  node.blur = () => {};
  node.scrollTo = () => {};
  node.scrollIntoView = () => {};
  node.setSelectionRange = () => {};
  node.select = () => {};
  // Метрики как у моноширинного шрифта 13px: виждеты привязываются к ним, и нули
  // сделали бы проверку раскладки фиктивной.
  node.getBoundingClientRect = () => {
    const width = String(node.textContent ?? '').length * 7.8;
    return { top: 0, left: 0, right: width, bottom: 20, width, height: 20, x: 0, y: 0, toJSON() {} };
  };
}

function walk(node: any, visit: (item: any) => void): void {
  for (const child of node.childNodes ?? []) {
    visit(child);
    walk(child, visit);
  }
}

function matchesSelector(node: any, selector: string): boolean {
  if (selector.startsWith('.')) {
    // `.a.b` — все классы обязательны, как в настоящем `querySelectorAll`.
    const fromClass = String(node.className ?? '')
      .split(/\s+/)
      .filter(Boolean);
    const fromList = Array.from((node.classList?.classes as Set<string> | undefined) ?? []);
    const own = new Set([...fromClass, ...fromList]);
    return selector
      .split('.')
      .filter(Boolean)
      .every((name) => own.has(name));
  }
  if (selector.startsWith('#')) return node.id === selector.slice(1);
  return String(node.tagName ?? '').toLowerCase() === selector.toLowerCase();
}

function find(node: any, selector: string): any {
  let found: any = null;
  walk(node, (item) => {
    if (!found && matchesSelector(item, selector)) found = item;
  });
  return found;
}

function makeNode(tag: string): MiniNode {
  const node: any = {
    tagName: tag.toUpperCase(),
    className: '',
    id: '',
    dataset: {},
    attrs: {} as Record<string, string>,
    children: [] as any[],
    childNodes: [] as any[],
    handlers: {} as Record<string, ((event: unknown) => void)[]>,
    classList: newClassList(),
    style: newStyle(),
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    draggable: false,
    selectionStart: 0,
    selectionEnd: 0,
    scrollTop: 0,
    scrollHeight: 0,
    clientWidth: 800,
    clientHeight: 600,
    offsetWidth: 800,
    offsetHeight: 600,
    isConnected: true,
    parentNode: null,
    _text: '',
  };
  defineTree(node);
  defineTreeOps(node);
  defineEvents(node);
  defineLookup(node);
  return node as MiniNode;
}

function newClassList(): any {
  return {
    classes: new Set<string>(),
    add(name: string) {
      this.classes.add(name);
    },
    remove(name: string) {
      this.classes.delete(name);
    },
    toggle(name: string, force?: boolean) {
      const on = force ?? !this.classes.has(name);
      if (on) this.classes.add(name);
      else this.classes.delete(name);
      return on;
    },
    contains(name: string) {
      return this.classes.has(name);
    },
  };
}

function newStyle(): any {
  return {
    cssText: '',
    props: {} as Record<string, string>,
    setProperty(key: string, value: string) {
      this.props[key] = value;
    },
    removeProperty(key: string) {
      delete this.props[key];
    },
    getPropertyValue(key: string) {
      return this.props[key] ?? '';
    },
  };
}

/**
 * Ставит мини-DOM глобально. Возвращает корень — в него монтируются виждеты.
 * `window` — тот же объект, что подставлен глобально: код читает `window.X`, а не
 * `globalThis.X`, и расхождение давало `undefined` в самых неожиданных местах.
 */
export function installMiniDom(): { root: MiniNode; document: any; window: any } {
  const body = makeNode('body');
  const document: any = {
    body,
    documentElement: makeNode('html'),
    head: makeNode('head'),
    createElement: makeNode,
    createElementNS: (_namespace: string, tag: string) => makeNode(tag),
    createTextNode: textNode,
    createDocumentFragment: () => makeNode('#fragment'),
    createComment: (text: string) => ({ nodeType: 8, textContent: text, parentNode: null }),
    querySelector: (selector: string) => find(body, selector),
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
    activeElement: null,
    hasFocus: () => true,
  };
  // Окно хранит обработчики по типам: меню и горячие клавиши слушают `window`, и без
  // этого их невозможно ни нажать, ни отпустить в тесте.
  const winHandlers: Record<string, ((event: any) => void)[]> = {};
  const window: any = {
    document,
    addEventListener(type: string, handler: (event: any) => void) {
      (winHandlers[type] ??= []).push(handler);
    },
    removeEventListener(type: string, handler: (event: any) => void) {
      winHandlers[type] = (winHandlers[type] ?? []).filter((item) => item !== handler);
    },
    dispatchEvent(event: { type: string }) {
      for (const handler of winHandlers[event.type] ?? []) handler(event);
      return true;
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  // `MutationObserver` нужен виджетам, следящим за атрибутами (шапка попапа
  // изменений разъезжается, если `hidden` сменился без их ведома). В тесте
  // наблюдатели не срабатывают: виджет и так перерисовывается явно.
  class MiniMutationObserver {
    observe(): void {}
    disconnect(): void {}
    takeRecords(): unknown[] {
      return [];
    }
  }
  // Глобальные имена, которые код берёт без `window.` (браузер отдаёт их так же).
  Object.assign(globalThis, {
    document,
    window,
    MutationObserver: MiniMutationObserver,
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame,
    getComputedStyle: window.getComputedStyle,
    matchMedia: window.matchMedia,
  });
  return { root: body, document, window };
}
