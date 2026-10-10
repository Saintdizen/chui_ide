import { describe, expect, it } from 'vitest';
import { APP_MENU, type MenuNode, type MenuRole } from '../src/shared/app-menu';

const ROLES: readonly MenuRole[] = [
  'undo',
  'redo',
  'cut',
  'copy',
  'paste',
  'selectAll',
  'reload',
  'toggleDevTools',
  'zoomReset',
  'zoomIn',
  'zoomOut',
  'fullscreen',
  'quit',
];

const walk = (nodes: readonly MenuNode[], visit: (node: MenuNode) => void): void => {
  for (const node of nodes) {
    visit(node);
    if (node.children) walk(node.children, visit);
  }
};

/**
 * Шаблон меню — один на два процесса (системное меню main и наш попап в renderer).
 * Тест держит то, из-за чего меню может «молчать»: у пункта нет ни команды, ни
 * роли, либо роль написана вне известного набора (её не поймёт ни один процесс).
 */
describe('меню приложения', () => {
  it('есть верхнеуровневые группы со вложенными пунктами', () => {
    expect(APP_MENU.length).toBeGreaterThan(0);
    for (const group of APP_MENU) {
      expect(group.label).toBeTruthy();
      expect(group.children && group.children.length).toBeTruthy();
    }
  });

  it('каждый осмысленный пункт — либо разделитель, либо команда, либо роль', () => {
    walk(APP_MENU, (node) => {
      if (node.separator) return;
      const isAction = Boolean(node.command) || Boolean(node.role);
      expect(isAction || Boolean(node.children)).toBe(true);
    });
  });

  it('у каждого листового пункта есть подпись', () => {
    walk(APP_MENU, (node) => {
      if (node.separator) return;
      expect(node.label).toBeTruthy();
    });
  });

  it('роли берутся из известного набора', () => {
    walk(APP_MENU, (node) => {
      if (node.role) expect(ROLES).toContain(node.role);
    });
  });

  it('команда и роль не стоят на одном пункте одновременно', () => {
    walk(APP_MENU, (node) => {
      expect(Boolean(node.command) && Boolean(node.role)).toBe(false);
    });
  });
});
