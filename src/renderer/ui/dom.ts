export type Child = Node | string | number | null | undefined | false;

export type PropValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | EventListener
  | Record<string, string>
  | Partial<CSSStyleDeclaration>;

/**
 * Мини-хелпер вместо фреймворка: те же несколько десятков строк закрывают
 * весь UI, и никакой реактивности с магией за спиной.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, PropValue> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  applyProps(element, props);
  append(element, children);
  return element;
}

export function append(parent: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (typeof child === 'string' || typeof child === 'number') {
      parent.appendChild(document.createTextNode(String(child)));
      continue;
    }
    parent.appendChild(child);
  }
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function applyProps(element: HTMLElement, props: Record<string, PropValue>): void {
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;

    if (key === 'class') element.className = String(value);
    else if (key === 'dataset' && typeof value === 'object') Object.assign(element.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(element.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (value === true) element.setAttribute(key, '');
    else element.setAttribute(key, String(value));
  }
}

const ICON_PATHS = {
  file: ['M4 1.5h5.5L12 4v10.5H4z', 'M9.5 1.5V4H12'],
  folder: ['M1.5 4A1.5 1.5 0 0 1 3 2.5h3l1.5 2h5.5A1.5 1.5 0 0 1 14.5 6v6A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12z'],
  chevron: ['M6 4l4 4-4 4'],
  refresh: ['M13.5 8a5.5 5.5 0 1 1-1.7-4', 'M13.5 2.5V6H10'],
  search: ['M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10z', 'M11 11l3.5 3.5'],
  save: ['M2.5 2.5h9l2 2v9h-11z', 'M5.5 2.5v4h5v-4', 'M5.5 13.5V9.5h5v4'],
  chat: ['M2.5 3.5h11v7h-6l-3 3v-3h-2z'],
  send: ['M2 8l12-5.5-5.5 12L7 9z'],
  // Треугольник «запустить»: тем же знаком размечен жёлоб редактора.
  play: ['M5.2 3.4 12.6 8l-7.4 4.6z'],
  stop: ['M4.5 4.5h7v7h-7z'],
  close: ['M4.5 4.5l7 7', 'M11.5 4.5l-7 7'],
  settings: [
    'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
    'M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4',
  ],
  sparkle: ['M8 1.5l1.6 4.4L14 7.5l-4.4 1.6L8 13.5l-1.6-4.4L2 7.5l4.4-1.6z'],
  wrench: [
    'M9.8 4.2a.93.93 0 0 0 0 .93l1.07 1.07a.93.93 0 0 0 .93 0l2.51-2.51a4 4 0 0 1-5.29 5.29l-4.61 4.61a1.41 1.41 0 0 1-2-2l4.61-4.61a4 4 0 0 1 5.29-5.29l-2.51 2.51z',
  ],
  warning: ['M8 2l6 11H2z', 'M8 6.2v3.6', 'M8 11.2v.5'],
  info: ['M8 14.5A6.5 6.5 0 1 0 8 1.5a6.5 6.5 0 0 0 0 13z', 'M8 7.4v4', 'M8 4.8v.5'],
  plus: ['M8 3.5v9', 'M3.5 8h9'],
  trash: ['M3 5h10', 'M5.2 5l.6 8.5h4.4L10.8 5', 'M6.2 5V3.4h3.6V5'],
  filePlus: ['M4 1.5h5.5L12 4v10.5H4z', 'M9.5 1.5V4H12', 'M8 7.4v3.6', 'M6.2 9.2h3.6'],
  folderPlus: ['M1.5 4A1.5 1.5 0 0 1 3 2.5h3l1.5 2h5.5A1.5 1.5 0 0 1 14.5 6v6A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12z', 'M8 7v4', 'M6 9h4'],
  chevronDown: ['M4 6.5l4 4 4-4'],
  chevronUp: ['M4 9.5l4-4 4 4'],
  // Восстановление в системном стиле Plasma: два шеврона вверх.
  chevronsUp: ['M4 9.5l4-4 4 4', 'M4 13l4-4 4 4'],
  terminal: ['M2.5 3h11v10h-11z', 'M5 7l2 2-2 2', 'M9 11h3'],
  collapse: ['M3 8h10', 'M5.5 5l2.5-2.5L10.5 5', 'M5.5 11l2.5 2.5L10.5 11'],
  panel: ['M2.5 3.5h11v9h-11z', 'M6.5 3.5v9'],
  branch: [
    'M4.6 4.8a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2',
    'M4.6 14.4a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2',
    'M11.6 9.4a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2',
    'M4.6 4.8v6.4',
    'M4.6 8.6h4.2a2.6 2.6 0 0 0 2.6-2.6',
  ],
  minus: ['M4 8h8'],
  revert: ['M3.6 7.4a4.6 4.6 0 1 1 1.5 3.6', 'M3.4 3.6v3.9h3.9'],
  command: ['M6 4.5a1.5 1.5 0 1 0-1.5 1.5H11.5A1.5 1.5 0 1 0 10 4.5v7a1.5 1.5 0 1 0 1.5-1.5H4.5A1.5 1.5 0 1 0 6 11.5z'],
  sun: ['M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1'],
  moon: ['M12.8 9.6A5.4 5.4 0 0 1 6.4 3.2a5.6 5.6 0 1 0 6.4 6.4z'],
  menu: ['M3 4.5h10', 'M3 8h10', 'M3 11.5h10'],
  // Лампочка — значок размышлений модели: думание, а не действие.
  bulb: ['M8 2.3a3.7 3.7 0 0 1 2.1 6.7V11H5.9V9A3.7 3.7 0 0 1 8 2.3z', 'M6.2 12.3h3.6', 'M7 13.8h2'],
  // Действия под сообщением: править текст вопроса, скопировать ответ, оценить ответ.
  copy: ['M5.5 5.5h7v7h-7z', 'M10.5 5.5v-2h-7v7h2'],
  pencil: ['M3.2 12.8 4.2 9.6 10.9 2.9a1.5 1.5 0 0 1 2.1 2.1L6.4 11.8z', 'M3.2 12.8 6.4 11.8'],
  // Палец вверх и вниз — зеркальные друг другу.
  thumbUp: [
    'M5.9 7.3 8.6 2.3a1.45 1.45 0 0 1 2.6 1.24l-.7 2.86h2.8a1.3 1.3 0 0 1 1.27 1.58l-1 4.2a1.45 1.45 0 0 1-1.41 1.12H5.9z',
    'M5.9 7.3H2.7v6h3.2',
  ],
  thumbDown: [
    'M5.9 8.7 8.6 13.7a1.45 1.45 0 0 0 2.6-1.24l-.7-2.86h2.8a1.3 1.3 0 0 0 1.27-1.58l-1-4.2a1.45 1.45 0 0 0-1.41-1.12H5.9z',
    'M5.9 8.7H2.7v-6h3.2',
  ],
  minimize: ['M4 8.5h8'],
  maximize: ['M4.5 4.5h7v7h-7z'],
  restore: ['M6 6.5h6.5V13H6z', 'M4 9.5v-6h6'],
  // Права доступа в композере: закрытый замок — спрашивать, открытый — полный доступ.
  lock: ['M4 7.5h8v6H4z', 'M6 7.5V5.5a2 2 0 0 1 4 0v2'],
  unlock: ['M4 7.5h8v6H4z', 'M6 7.5V5.5a2 2 0 0 1 3.9-.8'],
  // Значки режимов композера: вопрос — реплика, план — чек-лист (агент берёт wrench).
  bubble: ['M2.5 3.5h11v6.5H7.5L4.2 13v-3H2.5z'],
  checklist: ['M2.5 3.5h3v3h-3z', 'M2.5 9.5h3v3h-3z', 'M7.5 5h6', 'M7.5 11h6'],
} as const satisfies Record<string, readonly string[]>;

export type IconName = keyof typeof ICON_PATHS;

export function svgIcon(name: IconName, size = 16): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.3');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.classList.add('icon');
  for (const d of ICON_PATHS[name]) {
    const path = document.createElementNS(namespace, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, delay: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delay);
  };
}

export function basename(target: string): string {
  const trimmed = target.endsWith('/') ? target.slice(0, -1) : target;
  const index = trimmed.lastIndexOf('/');
  return index < 0 ? trimmed : trimmed.slice(index + 1);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}
