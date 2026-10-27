import { promises as fs } from 'node:fs';
import path from 'node:path';
import { RpcErrorCode } from '../../shared/api';
import { globToRegExp } from '../../shared/glob';
import { languageFromPath } from '../../shared/languages';
import {
  hashCommentsForPath,
  parseTemplate,
  structuralFind,
  structuralReplace,
  type StructuralFileMatches,
  type StructuralProjectMatches,
  type StructuralSearchOptions,
  type StructuralProjectOptions,
} from '../../shared/structural-search';
import {
  exportedNames,
  supportsExports,
  type ExportsQuery,
  type ExportsResult,
  type ExportFileHits,
} from '../../shared/symbol-exports';
import {
  inheritanceMatches,
  supportsInheritance,
  type InheritanceQuery,
  type InheritanceFileHits,
  type InheritanceResult,
} from '../../shared/type-inheritance';
import { RpcFailure } from '../ipc/router';

/** Файл больше этого не читаем ради обхода: держать его целиком в памяти не стоит. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Сколько совпадений по структуре отдаём на один файл: список читает человек. */
const MAX_STRUCTURAL_MATCHES_PER_FILE = 20;

/**
 * Что обходу нужно от рабочей области. Узко намеренно: файлы, корень и запись
 * с уведомлением — больше эти запросы ничего не знают.
 */
export interface CodeIndexPorts {
  /** Активный корень области: от него считаются относительные пути. */
  requireRoot(): string;
  /** Все файлы проекта путями на диске (служебные папки и игнор пропущены). */
  collectFiles(): Promise<string[]>;
  /** Запись файла нашим инструментом: повод спросить того, кто следит за диском. */
  beforeChange(file: string): Promise<void> | void;
  /** Кэш содержимого больше не верен для этого файла. */
  invalidate(file: string): void;
  /** Сказать дереву, что файл изменился. */
  notifyChanged(file: string): void;
}

/**
 * Вопросы по коду всего проекта — там, где сервер языка ответить не может.
 *
 * Всё это обход файлов: поиск по структуре, замена по структуре, где имя
 * объявлено экспортом, кто наследует тип. Отличие от `search` в том, что
 * `search` спрашивает ripgrep строчками, а здесь в файл нужно заглянуть
 * разбором — шаблон со скобками, объявления экспортов, иерархия типов.
 *
 * Обход общий и дешёвый: файлы и относительные пути берутся одним местом, а
 * разбор каждого языка живёт в `shared/` — здесь только отбор и склейка ответа.
 */
export function createCodeIndex(ports: CodeIndexPorts): {
  findByStructure(options: StructuralSearchOptions): Promise<StructuralProjectMatches>;
  replaceByStructure(options: StructuralProjectOptions): Promise<{ files: string[]; replaced: number }>;
  findExports(options: ExportsQuery): Promise<ExportsResult>;
  findInheritance(options: InheritanceQuery): Promise<InheritanceResult>;
} {
  const { requireRoot, collectFiles, beforeChange, invalidate, notifyChanged } = ports;

  /**
   * Пройти файлы проекта и отдать те, что прошли отбор, вместе с их текстом.
   *
   * Отбор у всех запросов одинаков: glob по относительному пути, размер в
   * пределах потолка, читаемый файл. Различия — только в том, что с текстом
   * делают дальше, и они остаются в каждом методе: так правило чтения одно,
   * а правило разбора видно на месте.
   */
  async function forEachFile(
    glob: string | undefined,
    visit: (file: string, relative: string, text: string) => boolean | void,
    // «Свой» файл: язык, который этот запрос умеет разбирать. Не свой в счёт
    // просмотренных не идёт — притворяться, что мы там что-то смотрели, нечестно.
    accepted: (relative: string) => boolean = () => true,
  ): Promise<number> {
    const root = requireRoot();
    const matcher = glob?.trim() ? globToRegExp(glob.trim()) : null;
    let scanned = 0;

    for (const file of await collectFiles()) {
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (matcher && !matcher.test(relative)) continue;
      const stat = await fs.stat(file).catch(() => null);
      if (!stat || stat.size > MAX_FILE_BYTES) continue;
      if (!accepted(relative)) continue;
      const buffer = await fs.readFile(file).catch(() => null);
      if (!buffer) continue;
      scanned += 1;
      // `false` от посетителя — файл разобран, но дальше смотреть нечего.
      if (visit(file, relative, buffer.toString('utf8').replace(/\r\n/g, '\n')) === false) continue;
    }
    return scanned;
  }

  return {
    /**
     * Поиск по структуре: шаблон со скобками, а не строка. Отличается от обычного
     * поиска тем, что `{…}` в шаблоне — дырка, и находит он независимо от того,
     * что внутри.
     */
    async findByStructure(options: StructuralSearchOptions): Promise<StructuralProjectMatches> {
      const template = parseTemplate(options.pattern);
      if (template.error) throw new RpcFailure(RpcErrorCode.InvalidParams, template.error);

      const files: StructuralFileMatches[] = [];
      let total = 0;
      const scanned = await forEachFile(options.glob, (file, relative, text) => {
        const matches = structuralFind(text, template, { hashComments: hashCommentsForPath(relative) });
        if (matches.length === 0) return;
        total += matches.length;
        files.push({
          path: file,
          count: matches.length,
          matches: matches.slice(0, MAX_STRUCTURAL_MATCHES_PER_FILE),
        });
      });

      return { files, total, scanned };
    },

    /**
     * Замена по структуре по всему проекту: идём теми же файлами, пишем только те, где
     * что-то реально изменилось. Возвращаем изменённые пути — renderer по ним перечитывает
     * открытые вкладки.
     *
     * Читает ли `#` как комментарий, решает расширение: в CSS или markdown `#` — не
     * комментарий, и читать такие файлы общим правилом значило бы править не то.
     */
    async replaceByStructure(options: StructuralProjectOptions): Promise<{ files: string[]; replaced: number }> {
      const template = parseTemplate(options.pattern);
      if (template.error) throw new RpcFailure(RpcErrorCode.InvalidParams, template.error);

      const changed: string[] = [];
      let replaced = 0;
      // Посетитель синхронный, а запись асинхронна: собираем пары и пишем после обхода,
      // чтобы не держать обход в ожидании диска.
      const writes: { file: string; text: string; count: number }[] = [];

      await forEachFile(options.glob, (file, relative, text) => {
        const result = structuralReplace(text, template, options.replacement, {
          hashComments: hashCommentsForPath(relative),
        });
        if (result.count === 0) return;
        replaced += result.count;
        writes.push({ file, text: result.text, count: result.count });
      });

      for (const write of writes) {
        await beforeChange(write.file);
        await fs.writeFile(write.file, write.text, 'utf8');
        invalidate(write.file);
        notifyChanged(write.file);
        changed.push(write.file);
      }

      return { files: changed, replaced };
    },

    /**
     * Где имя объявлено ЭКСПОРТОМ. Обходим те же файлы, что замена по структуре, и в каждом
     * разбираем экспорты по языку (JS/TS и Python). Это не запрос к серверу: в LSP такого
     * запроса нет, а видно экспорт по самому тексту — `export`, `__all__`, `def`/`class`.
     *
     * Прочие языки пропускаем: там экспорт мы не разбираем, и притворяться, что «нашлось
     * ничего», нечестно — поэтому список просмотренных файлов идёт наружу (`scanned`).
     */
    async findExports(options: ExportsQuery): Promise<ExportsResult> {
      const name = options.name.trim();
      if (name === '') throw new RpcFailure(RpcErrorCode.InvalidParams, 'Не задано имя символа');

      const files: ExportFileHits[] = [];
      let total = 0;
      const scanned = await forEachFile(
        options.glob,
        (file, relative, text) => {
          const found = exportedNames(text, languageFromPath(relative)).filter((entry) => entry.name === name);
          if (found.length === 0) return;
          total += found.length;
          files.push({ path: file, entries: found });
        },
        (relative) => supportsExports(languageFromPath(relative)),
      );

      return { name, files, total, scanned };
    },

    /**
     * Наследование имени: «кто наследует» (`direction: 'subtypes'`) или «от кого наследует»
     * (`'supertypes'`). Обходим те же файлы, что поиск экспортов, и разбираем объявления
     * типов по языку. Это не запрос к серверу: иерархию типов сервер показывает для символа
     * под курсором, а тут нужен ответ по всему проекту.
     *
     * Языки без разбора пропускаем: притворяться, что «не нашлось», там нечестно.
     */
    async findInheritance(options: InheritanceQuery): Promise<InheritanceResult> {
      const name = options.name.trim();
      if (name === '') throw new RpcFailure(RpcErrorCode.InvalidParams, 'Не задано имя типа');
      const direction = options.direction === 'supertypes' ? 'supertypes' : 'subtypes';

      const files: InheritanceFileHits[] = [];
      let total = 0;
      const scanned = await forEachFile(
        options.glob,
        (file, relative, text) => {
          const found = inheritanceMatches(text, languageFromPath(relative), name, direction);
          if (found.length === 0) return;
          total += found.length;
          files.push({ path: file, entries: found });
        },
        (relative) => supportsInheritance(languageFromPath(relative)),
      );

      return { name, direction, files, total, scanned };
    },
  };
}
