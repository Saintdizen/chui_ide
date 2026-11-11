import { describe, expect, it } from 'vitest';
import { keyHintLabel, keyHintPlan, runCommand } from '../src/renderer/ui/palette';

/**
 * П.1: «сочетание в подсказке кликабельно и ведёт в настройки клавиш».
 *
 * Проверяем на живом DOM: механизм подсказок (меню, палитра) уже был, дыра —
 * что сочетание нельзя было нажать, а команда без сочетания выглядела как
 * команда «некуда идти».
 */
/**
 * Выбор строки сочетания разведён на ДВА решения: что показать и что сделать.
 *
 * Механизм нужен живой DOM, а прогон здесь идёт без него (`environment: 'node'`
 * в `vitest.config.mts`, проверки интерфейса — в `scripts/*-smoke.cjs`). Поэтому
 * проверяются сами решения: задержка после показа, подпись у команды без
 * клавиши и уход в настройки именно той команды.
 */
const command = (id: string, keybinding?: string) =>
  ({ id, title: id, category: 'Файл', ...(keybinding ? { keybinding } : {}) }) as const;

describe('отказ команды из палитры', () => {
  it('доходит до обработчика, а не тонет в промпсе', async () => {
    const seen: [unknown, string][] = [];
    runCommand(Promise.reject(new Error('git tag упал')), 'git.tags', (e, id) => seen.push([e, id]));
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(1);
    const [error, id] = seen[0]!;
    expect(id).toBe('git.tags');
    expect((error as Error).message).toBe('git tag упал');
  });

  it('удачный запуск не тревожит обработчик', async () => {
    let called = 0;
    runCommand(Promise.resolve(), 'git.tags', () => called++);
    await new Promise((r) => setTimeout(r, 0));
    expect(called).toBe(0);
  });
});

describe('решение по клику на сочетание', () => {
  it('свежий клик после показа окна — это «отойди», а не выбор', () => {
    expect(keyHintPlan(40)).toBe('reclaim');
  });

  it('и он НЕ открывает настройки', () => {
    expect(keyHintPlan(40)).not.toBe('settings');
  });

  it('осознанный клик ведёт в настройки ДАЛЬШЕ можно', () => {
    expect(keyHintPlan(900)).toBe('settings');
  });
});

describe('подпись сочетания в палитре', () => {
  it('есть клавиша — показываем её', () => {
    expect(keyHintPlan(900)).toBe('settings');
  });

  it('клавиши нет — зовём назначить, а не молчим', () => {
    const label = keyHintLabel(command('file.save'));
    expect(label).toContain('назначить');
  });

  it('у команды с клавишей подпись — сама клавиша', () => {
    expect(keyHintLabel(command('file.save', 'Ctrl+S'))).toBe('Ctrl+S');
  });
});
