import { fileIconOf, type FileIconKind } from '../../shared/languages';

/**
 * Значки файлов и папок для дерева проекта.
 *
 * Рисуем их сами, а не берём готовый набор: значков нужно два десятка, а тема
 * приложения знает роли цветов и две схемы. Форма одна — лист бумаги с буквами
 * языка внутри, как в Material Icon Theme: буквы вырезаны фоном панели, поэтому
 * значок читается и в тёмной схеме, и в светлой, и на выделенной строке.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Лист бумаги: угол срезан, сгиб закрашен плотнее — тень от загнутого уголка. */
const DOC_BODY = 'M4.4 1.4h4.3l3.9 3.9v8.4c0 .5-.4.9-.9.9H4.4c-.5 0-.9-.4-.9-.9V2.3c0-.5.4-.9.9-.9z';
const DOC_FOLD = 'M8.7 1.4 12.6 5.3H8.7z';

/** Папка: закрытая — цельный конверт, открытая — с отогнутой передней стенкой. */
const FOLDER_CLOSED =
  'M2 4.6c0-.6.5-1.1 1.1-1.1h2.7c.4 0 .7.2.9.5l.7 1h4.5c.6 0 1.1.5 1.1 1.1v5.4c0 .6-.5 1.1-1.1 1.1H3.1C2.5 12.6 2 12.1 2 11.5z';
const FOLDER_OPEN_BACK =
  'M2.4 11.1V4.5c0-.6.5-1.1 1.1-1.1h2.6c.4 0 .7.2.9.5l.7 1h4.2c.6 0 1.1.5 1.1 1.1v1.1H5.6c-.9 0-1.6.6-1.9 1.4z';
const FOLDER_OPEN_FRONT = 'M3.4 14l1.4-5.2c.1-.4.5-.7 1-.7h7.5c.6 0 1 .5.9 1.1l-1.3 4.8z';

/** Файлы без знакомого расширения — просто нейтральный лист. */
const NO_BADGE: readonly FileIconKind[] = ['text', 'lock', 'git', 'image', 'archive', 'database', 'docker'];

type Shape = { d: string; opacity?: number };

/** Вместо букв у части видов — узнаваемый знак: картинка, замок, ветка git. */
const GLYPHS: Partial<Record<FileIconKind, readonly Shape[]>> = {
  image: [{ d: 'M5.2 12.4l1.9-2.3 1.3 1.5.9-1 1.6 1.8z' }, { d: 'M9.9 7.9a.8.8 0 1 1-1.6 0 .8.8 0 0 1 1.6 0' }],
  archive: [
    { d: 'M5.1 7.6h6v4.9h-6z', opacity: 0.9 },
    { d: 'M5.1 9.4h6', opacity: 0.55 },
  ],
  lock: [
    { d: 'M5.5 8.3h5.2v4.1H5.5z', opacity: 0.9 },
    { d: 'M6.7 8.3V7a1.4 1.4 0 0 1 2.8 0v1.3', opacity: 0.75 },
  ],
  git: [
    { d: 'M6.9 5.4v4.9', opacity: 0.85 },
    { d: 'M6.9 8.9h1.7a1.6 1.6 0 0 0 1.6-1.6V6.1', opacity: 0.85 },
    { d: 'M7.8 4.6a.9.9 0 1 1-1.8 0 .9.9 0 0 1 1.8 0', opacity: 0.9 },
    { d: 'M11 5.3a.9.9 0 1 1-1.8 0 .9.9 0 0 1 1.8 0', opacity: 0.9 },
  ],
  database: [
    { d: 'M5.2 7.4c0-.6 1.3-1.1 2.9-1.1s2.9.5 2.9 1.1v4.3c0 .6-1.3 1.1-2.9 1.1s-2.9-.5-2.9-1.1z', opacity: 0.9 },
    { d: 'M5.2 9.5c0 .6 1.3 1.1 2.9 1.1s2.9-.5 2.9-1.1', opacity: 0.5 },
  ],
  docker: [
    { d: 'M5.2 7.8h1.5v1.5H5.2z', opacity: 0.9 },
    { d: 'M7 7.8h1.5v1.5H7z', opacity: 0.9 },
    { d: 'M8.8 7.8h1.5v1.5H8.8z', opacity: 0.9 },
    { d: 'M7 6h1.5v1.5H7z', opacity: 0.6 },
    { d: 'M5.2 10.6h7.6c0 1.3-1.2 2.2-3.1 2.2-2 0-3.8-.8-4.5-2.2z', opacity: 0.75 },
  ],
};

function element<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

/** Буква языка внутри листа. Кегль зависит от длины: три буквы шире двух. */
function badgeFontSize(badge: string): number {
  if (badge.length <= 1) return 6.2;
  if (badge.length === 2) return 5;
  if (badge.length === 3) return 4;
  return 3.3;
}

export function fileIcon(filePath: string, size = 15): SVGSVGElement {
  const { kind, badge } = fileIconOf(filePath);
  const svg = element('svg', {
    viewBox: '0 0 16 16',
    width: size,
    height: size,
    class: `file-icon is-${kind}`,
    'aria-hidden': 'true',
  });

  svg.appendChild(element('path', { d: DOC_BODY, fill: 'currentColor', 'fill-opacity': 0.9 }));
  svg.appendChild(element('path', { d: DOC_FOLD, fill: 'currentColor', 'fill-opacity': 0.55 }));

  const glyph = GLYPHS[kind];
  if (glyph) {
    for (const shape of glyph) {
      // Цвет-вырез задаётся через `style`, а не атрибутом `fill`: `var()`
      // в презентационных атрибутах не вычисляется — в них только готовые значения.
      svg.appendChild(
        element('path', {
          d: shape.d,
          style: `fill: var(--file_badge); fill-opacity: ${shape.opacity ?? 1}`,
        }),
      );
    }
    return svg;
  }

  // Пустая подпись — лист без букв: так выглядят текстовые файлы и замки версий.
  if (badge && !NO_BADGE.includes(kind)) {
    const text = element('text', {
      x: 8.1,
      y: 12.3,
      'text-anchor': 'middle',
      'font-size': badgeFontSize(badge),
      'font-weight': 700,
      'letter-spacing': '-0.2',
      style: 'fill: var(--file_badge)',
    });
    text.textContent = badge;
    svg.appendChild(text);
  }

  return svg;
}

/**
 * Имя папки красит её значок: `src` не должен выглядеть как `dist`.
 * Список короткий намеренно — цвет сообщает смысл, а не украшает.
 */
const FOLDER_TINTS: Record<string, string> = {
  src: 'source',
  source: 'source',
  app: 'source',
  lib: 'source',
  packages: 'source',
  dist: 'build',
  build: 'build',
  out: 'build',
  release: 'build',
  target: 'build',
  node_modules: 'deps',
  vendor: 'deps',
  '.venv': 'deps',
  venv: 'deps',
  __pycache__: 'deps',
  '.git': 'git',
  '.github': 'ci',
  test: 'test',
  tests: 'test',
  __tests__: 'test',
  spec: 'test',
  docs: 'docs',
  doc: 'docs',
  assets: 'assets',
  static: 'assets',
  public: 'assets',
  images: 'assets',
  scripts: 'scripts',
  bin: 'scripts',
  tools: 'scripts',
};

export function folderIcon(name: string, open: boolean, size = 15): SVGSVGElement {
  const tint = FOLDER_TINTS[name.toLowerCase()] ?? 'default';
  const svg = element('svg', {
    viewBox: '0 0 16 16',
    width: size,
    height: size,
    class: `folder-icon is-${tint}${open ? ' is-open' : ''}`,
    'aria-hidden': 'true',
  });

  if (open) {
    svg.appendChild(element('path', { d: FOLDER_OPEN_BACK, fill: 'currentColor', 'fill-opacity': 0.55 }));
    svg.appendChild(element('path', { d: FOLDER_OPEN_FRONT, fill: 'currentColor', 'fill-opacity': 0.9 }));
  } else {
    svg.appendChild(element('path', { d: FOLDER_CLOSED, fill: 'currentColor', 'fill-opacity': 0.9 }));
  }

  return svg;
}
