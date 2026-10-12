import { describe, expect, it } from 'vitest';
import { APP_MENU, MENU_TOGGLES, menuChecks, type MenuNode, type MenuRole } from '../src/shared/app-menu';

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
      expect(group.children?.length).toBeTruthy();
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

  it('отметки переключателей идут за состоянием', () => {
    const checks = menuChecks({ sidebar: true, aiPanel: false, terminal: true, theme: 'light' });
    expect(checks[MENU_TOGGLES.sidebar]).toBe(true);
    expect(checks[MENU_TOGGLES.aiPanel]).toBe(false);
    expect(checks[MENU_TOGGLES.terminal]).toBe(true);
    expect(checks[MENU_TOGGLES.themeLight]).toBe(true);
    expect(checks[MENU_TOGGLES.themeDark]).toBe(false);
    expect(checks[MENU_TOGGLES.themeSystem]).toBe(false);
  });

  it('ровно одна тема отмечена при любом выборе', () => {
    for (const theme of ['dark', 'light', 'system'] as const) {
      const checks = menuChecks({ sidebar: false, aiPanel: false, terminal: false, theme });
      const themes = [
        checks[MENU_TOGGLES.themeDark],
        checks[MENU_TOGGLES.themeLight],
        checks[MENU_TOGGLES.themeSystem],
      ];
      expect(themes.filter(Boolean)).toHaveLength(1);
    }
  });

  it('каждая команда-переключатель есть в шаблоне меню', () => {
    const commands = new Set<string>();
    walk(APP_MENU, (node) => {
      if (node.command) commands.add(node.command);
    });
    for (const id of Object.values(MENU_TOGGLES)) expect(commands.has(id)).toBe(true);
  });

  // Причина проверки: «Сохранить как…» и «Сохранить всё» однажды оказались на одной
  // клавише (Ctrl+Shift+S). Два пункта с одним ускорителем — это тот, который молча
  // не срабатывает или срабатывает не тот.
  it('у пунктов меню нет двух одинаковых сочетаний', () => {
    const used = new Map<string, string[]>();
    walk(APP_MENU, (node) => {
      if (!node.accelerator) return;
      used.set(node.accelerator, [...(used.get(node.accelerator) ?? []), node.label ?? '?']);
    });
    const clashes = [...used.entries()].filter(([, labels]) => labels.length > 1);
    expect(clashes).toEqual([]);
  });

  it('«Сохранить как…» есть в меню и стоит на Ctrl+Shift+S', () => {
    const items: MenuNode[] = [];
    walk(APP_MENU, (node) => items.push(node));
    const saveAs = items.find((node) => node.command === 'file.saveAs');
    expect(saveAs?.accelerator).toBe('Ctrl+Shift+S');
  });
});
