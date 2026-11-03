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
  const dir = `${root}/.vscode`;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    // Нет `.vscode` — обычное дело, а не ошибка.
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
