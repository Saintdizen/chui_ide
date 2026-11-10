import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  parseEditorConfig,
  resolveEditorConfig,
  type EditorConfigFile,
  type ResolvedEditorConfig,
} from '../shared/editorconfig';

/**
 * Поиск `.editorconfig` от файла вверх до корня проекта.
 *
 * Выше корня не идём: `.editorconfig` в домашней папке человека — его личное
 * дело, а не договор о проекте, и подхватывать его молча значило бы менять
 * вид файлов проекта по чужим правилам. Брать же только тот, что лежит
 * рядом с файлом, нельзя: обычно он один на корень.
 *
 * Читаем при каждом обращении: `.editorconfig` правят редко и обычно
 * перезапускают IDE после этого, а кэш без слежения за файлом давал бы
 * устаревшие значения и никак не сказал бы об этом.
 */
export async function readEditorConfigFor(root: string, filePath: string): Promise<ResolvedEditorConfig> {
  const layers: EditorConfigFile[] = [];
  const rootPath = path.resolve(root);
  const target = path.resolve(filePath);
  let dir = path.dirname(target);

  // Не больше глубины пути: защита от петли на странном пути.
  for (let guard = 0; guard < 64; guard += 1) {
    const inside = dir === rootPath || dir.startsWith(rootPath + path.sep);
    if (!inside) break;

    const found = await readOne(path.join(dir, '.editorconfig'));
    if (found !== null) {
      layers.push(found);
      // `root = true` останавливает поиск вверх — так задумано в спецификации.
      if (found.isRoot) break;
    }
    if (dir === rootPath) break;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }

  // Собирали от ближнего к дальнему, а решать должен ближний — разворачиваем.
  layers.reverse();
  const relative = path.relative(rootPath, target).split(path.sep).join('/');
  return resolveEditorConfig(relative, layers);
}

/** Прочитать один `.editorconfig`. Нет файла или не текст — `null`, без шума. */
async function readOne(file: string): Promise<EditorConfigFile | null> {
  try {
    return parseEditorConfig(await readFile(file, 'utf8'));
  } catch {
    // Нет файла — обычное дело: `.editorconfig` есть не в каждом проекте.
    return null;
  }
}
