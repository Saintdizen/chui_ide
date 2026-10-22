import type { TextDocument } from './document';
import type { DefineCommand } from './command-args';
import type { RunTarget } from './run-config';

/** Кнопка запуска в шапке: команде «Запустить…» нужен только её прямоугольник. */
export interface RunControlAnchor {
  readonly element: HTMLElement;
}

export interface RunMenuItem {
  label: string;
  hint?: string;
  onSelect(): void;
}

/**
 * Команды запуска. Расчёт целей (`targetsFor`, `testTarget`) и сам прогон
 * (`runTarget`) остаются в `app.ts`: ими пользуются ещё кнопка в шапке, статус-бар и
 * панель задач, а не только команды. Здесь — только то, чем эти команды отвечают
 * человеку: какой цели нет, что показать в меню и что сказать при отказе.
 */
export interface RunCommandDeps {
  openEditors: { readonly active: TextDocument | null };
  targetsFor(document: TextDocument | null): RunTarget[];
  testTarget(): RunTarget | undefined;
  runTarget(target: RunTarget): Promise<void>;
  runControl: RunControlAnchor;
  showMenu(items: RunMenuItem[], x: number, y: number, options: { anchor: HTMLElement }): void;
  showToast(message: string, kind?: 'error'): void;
}

export function registerRunCommands(define: DefineCommand, deps: RunCommandDeps): void {
  const { openEditors, targetsFor, testTarget, runTarget, runControl, showMenu, showToast } = deps;

  define(
    {
      id: 'run.file',
      title: 'Запустить файл',
      category: 'Запуск',
      keybinding: 'Ctrl+F5',
      enabled: () => targetsFor(openEditors.active).some((item) => item.source === 'file'),
    },
    async () => {
      // Именно файл, а не первая цель из набора: у Python первыми могли оказаться
      // тесты, и Ctrl+F5 запускал бы их вместо самого файла.
      const target = targetsFor(openEditors.active).find((item) => item.source === 'file');
      if (!target) {
        showToast('Запускать нечего: нужен скрипт или задача в package.json', 'error');
        return;
      }
      await runTarget(target);
    },
  );

  define(
    { id: 'run.tests', title: 'Запустить тесты', category: 'Запуск', enabled: () => testTarget() !== undefined },
    async () => {
      const target = testTarget();
      if (!target) {
        showToast('Тесты не найдены: нужен pytest, vitest, jest или файлы для `node --test`', 'error');
        return;
      }
      await runTarget(target);
    },
  );

  define(
    {
      id: 'run.choose',
      title: 'Запустить…',
      category: 'Запуск',
      keybinding: 'Shift+F10',
      enabled: () => targetsFor(openEditors.active).length > 0,
    },
    () => {
      const targets = targetsFor(openEditors.active);
      if (targets.length === 0) {
        showToast('Запускать нечего: нужен скрипт или задача в package.json', 'error');
        return;
      }
      if (targets.length === 1) {
        void runTarget(targets[0]!);
        return;
      }
      const anchor = runControl.element;
      const rect = anchor.getBoundingClientRect();
      showMenu(
        targets.map((target) => ({ label: target.label, hint: target.detail, onSelect: () => void runTarget(target) })),
        rect.right - 260,
        rect.bottom + 4,
        { anchor },
      );
    },
  );
}
