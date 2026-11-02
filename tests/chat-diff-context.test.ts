import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MENU = readFileSync(resolve(process.cwd(), 'src/renderer/ui/chat-composer-menu.ts'), 'utf8');
const ATTACH = readFileSync(resolve(process.cwd(), 'src/renderer/ui/chat-attachments.ts'), 'utf8');

describe('#diff — правки проекта как контекст', () => {
  it('пункт есть в меню композера и отдаёт вид diff', () => {
    expect(MENU).toContain("id: '#diff'");
    expect(MENU).toContain("kind: 'diff'");
    expect(MENU).toContain("'diff'");
  });

  it('git не обязателен: без него чат работает, а #diff молчит', () => {
    expect(ATTACH).toContain('git?: GitModel');
    expect(ATTACH).toContain('if (!git?.isRepository)');
  });

  it('берём и индекс, и рабочее дерево: разница для вопроса не важна', () => {
    expect(ATTACH).toContain('[...git.staged, ...git.unstaged]');
  });

  it('пустое дерево и переполнение не делают вид, что контекста нет', () => {
    // Чистое дерево — не ошибка. Больше десятка файлов — списком без содержимого.
    expect(ATTACH).toContain('Изменений нет: рабочее дерево чистое');
    expect(ATTACH).toContain('const MAX_DIFF_FILES = 10;');
    expect(ATTACH).toContain('Ещё изменено (без содержимого)');
  });
});
