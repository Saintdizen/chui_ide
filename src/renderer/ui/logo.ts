import { LOGO_HEIGHT, LOGO_RECTS, LOGO_WIDTH } from '../../shared/logo';

/**
 * Знак приложения — «[i_i]» в стиле моноширинного шрифта.
 *
 * Геометрию знак берёт из `shared/logo.ts`: там же её читает растеризатор
 * значка окна, поэтому интерфейс и ярлык рисуют одно и то же. Знак состоит
 * из прямоугольников, так что здесь — только сборка SVG.
 *
 * Текстом знак не рисуем: он не должен зависеть от того, какой шрифт стоит
 * на машине.
 */
export function logoMark(size = 40): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', `0 0 ${LOGO_WIDTH} ${LOGO_HEIGHT}`);
  svg.setAttribute('width', String(Math.round((size * LOGO_WIDTH) / LOGO_HEIGHT)));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('logo-mark');

  for (const rect of LOGO_RECTS) {
    const node = document.createElementNS(namespace, 'rect');
    node.setAttribute('x', String(rect.x));
    node.setAttribute('y', String(rect.y));
    node.setAttribute('width', String(rect.width));
    node.setAttribute('height', String(rect.height));
    if (rect.rx) node.setAttribute('rx', String(rect.rx));
    // Цвет берём из `color` элемента-хозяина: знак стоит и на тёмном фоне,
    // и на светлом, и на акцентной заливке.
    node.setAttribute('fill', 'currentColor');
    svg.appendChild(node);
  }

  return svg;
}
