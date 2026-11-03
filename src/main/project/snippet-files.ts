import { readdir, readFile } from 'node:fs/promises';

/**
 * Сниппеты чужого проекта: файлы `.vscode/*.code-snippets`.
 *
 * Читать их в renderer нельзя — там нет файловой системы, а тянуть каждый файл
 * отдельным запросом значит знать заранее их имена. Собираем на стороне main
 * одним проходом: папка небольшая, а ошибка на любом файле не должна лишать
 * человека остальных.
 */
export async function readProjectSnippets(root: string): Promise<{ name: string; text: string }[]> {
  // Нет `.vscode` — обычное дело, а не ошибка: вернётся пусто.
  return readSnippetDir(`${root}/.vscode`);
}

/** Все `.code-snippets` из папки; непрочитанный файл не отменяет остальные. */
async function readSnippetDir(dir: string): Promise<{ name: string; text: string }[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files: { name: string; text: string }[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.code-snippets')) continue;
    try {
      files.push({ name, text: await readFile(`${dir}/${name}`, 'utf8') });
    } catch {
      // Один нечитаемый файл не отменяет остальные.
    }
  }
  return files;
}

/**
 * Свои сниппеты пользователя: `<userData>/snippets/*.code-snippets`.
 *
 * Формат тот же, что у проекта, — чтобы набор, принесённый из VS Code, можно было
 * просто положить в папку. Отдельно от проектных: они нужны во всех проектах,
 * а проектные — только в своём.
 */
export async function readUserSnippets(dir: string): Promise<{ name: string; text: string }[]> {
  return readSnippetDir(dir);
}
