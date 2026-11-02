/**
 * Сторож границы слоёв: `npm run check:layers`.
 *
 * Правила — в `src/shared/layer-rules.ts` (проверяются тестом на строках), разбор
 * импортов — в `src/shared/layer-imports.ts`. Здесь только обход файлов.
 *
 * Запуск через `rolldown`: `tsx` в devDependencies есть, а в установленном дереве
 * его нет, и `npm run check:static` падал бы на отсутствующем бинарнике.
 * `rolldown` уже нужен сборке preload — им же собирается и этот файл.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { findImports } from '../src/shared/layer-imports';
import { checkSharedImport, type LayerContext } from '../src/shared/layer-rules';

export const projectRoot = path.resolve(process.env.CHUI_PROJECT_ROOT ?? process.cwd());
const sharedDir = path.join(projectRoot, 'src/shared');

/** Все файлы общего кода: рекурсивно, только `.ts`. */
async function collect(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(full)));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

/** Имена пакетов проекта: из общего слоя их тянуть можно только осознанно. */
async function appDependencies(): Promise<ReadonlySet<string>> {
  const raw = await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8');
  const manifest = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]);
}

/** `true` — граница цела. Вызывается из раннера и проверяется тестом. */
export async function checkLayers(): Promise<boolean> {
  const context: LayerContext = { deps: await appDependencies(), sharedDir };
  const files = await collect(sharedDir);
  const problems: string[] = [];

  for (const file of files) {
    const source = await fs.readFile(file, 'utf8');
    for (const found of findImports(source)) {
      // `file` — абсолютный: правила сравнивают сегменты пути с `sharedDir`.
      const problem = checkSharedImport(file, found.specifier, context);
      // Путь в сообщении — относительно корня: так он кликается в выводе CI.
      if (problem !== null) problems.push(`${path.relative(projectRoot, file)}: ${problem}`);
    }
  }

  if (problems.length > 0) {
    console.error(`Граница shared нарушена (${problems.length}):`);
    for (const problem of problems) console.error(`  ${problem}`);
    return false;
  }
  console.log(`Граница shared на месте: проверено файлов — ${files.length}`);
  return true;
}
