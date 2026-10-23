import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Панель инструментов композера: что на ней написано.
 *
 * Ряд у поля ввода узкий, и слова в нём достаются только тому, что без значка не
 * читается: права — это замок (подпись ушла в подсказку и в строки списка), модель —
 * одно имя (провайдер в подсказке). Список выбора при этом остаётся с подписями.
 *
 * Сторож читает исходник: подпись — это текст, а не поведение, и проверить его
 * иначе, чем по коду, нечем (селект живёт в DOM, тесты — в node).
 */
const COMPOSER = readFileSync(resolve(process.cwd(), 'src/renderer/ui/chat-composer.ts'), 'utf8');

describe('подписи в панели композера', () => {
  it('кнопка прав — только значки, список — с подписями', () => {
    expect(COMPOSER).toMatch(/createSelect\(\{[^}]*composer-perm'[^}]*iconOnly: true/);
    // Список тот же самый: подписи он берёт из `PERMISSION_PRESETS`.
    expect(COMPOSER).toContain('PERMISSION_PRESETS.map((item) => ({\n      value: item.id,\n      label: item.label,');
  });

  it('кнопка модели — без провайдера, он остаётся в подсказке', () => {
    expect(COMPOSER).toContain('modelLabel.textContent = model;');
    expect(COMPOSER).toMatch(/modelButton\.title = `\$\{providerLabel\} · \$\{model\}/);
  });
});
