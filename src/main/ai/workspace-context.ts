import fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  appliedInstruction,
  describeBrokenLinks,
  findBrokenLinks,
  formatInstructionFile,
  instructionFoldersFor,
  type AppliedInstruction,
  type ProjectPaths,
} from '../../shared/instructions';
import { formatMemory } from '../../shared/memory';
import { formatSkillCatalog } from '../../shared/skills';
import type { SkillLibrary } from './skills';
import { formatShortMap } from '../../shared/project-map';
import { scanProject } from '../project/scan';
import { listProjectFiles } from '../project/scan';
import type { WorkspaceService } from '../workspace/workspace';
import { readStamp } from '../../shared/read-coverage';
import type { ProjectMemory } from './project-memory';

/**
 * Файлы с правилами проекта — подмешиваются в системный промпт. Читаются все,
 * а не первый найденный: имена разные не потому, что это варианты одного файла,
 * а потому, что так их называют разные инструменты, и в проекте их заводит
 * каждый свой. `.ai_rules` — наше имя, оно читается первым: если человек завёл
 * его, его правила должны стоять выше чужих.
 *
 * Правила бывают и в подпапках (`src/AGENTS.md`): ближайший вверх по дереву файл
 * побеждает — тот же приём, что у Cursor. Ближайший — значит позже в промпте, и
 * в его шапке назван путь от корня, иначе одинаковые `AGENTS.md` не различить.
 *
 * Порядок в списке = порядок в промпте: сначала общие правила проекта, потом
 * уточнения инструментов.
 */
export const INSTRUCTION_FILES = ['.ai_rules', 'AGENTS.md', 'CHUI.md', 'CLAUDE.md'];

/** Потолок на один файл правил. */
export const MAX_INSTRUCTIONS_BYTES = 4000;

/**
 * Потолок на все файлы правил вместе. Длинный файл съест его целиком — это
 * осознанно: правила, которые человек завёл, важнее правил чужого инструмента.
 */
export const MAX_INSTRUCTIONS_TOTAL_BYTES = 6000;

/**
 * Карта проекта, память и правила проекта — всё, что агент видит до первого
 * вызова инструмента. Вынесено из `AiService`: здесь чтение с диска и сборка
 * текста, а не диалог с моделью.
 */
export class WorkspaceContext {
  constructor(
    private readonly workspace: WorkspaceService,
    private readonly memory: ProjectMemory,
    /** Навыки проекта: в промпт идёт только каталог, тело — инструментом `skill`. */
    private readonly skills?: SkillLibrary,
  ) {}

  /**
   * Скан обходит дерево, поэтому держим результат до смены папки: в каждом
   * запросе обходить проект заново — платить за одно и то же. Числа поэтому
   * могут отстать от жизни (агент что-то создал) — за свежими он идёт в
   * `project_map`, который сканирует на каждый вызов.
   */
  private mapCache: { root: string; text: string } | null = null;

  /**
   * Пути проекта для сверки ссылок из правил — вместе с картой: оба берутся из одного
   * обхода. `null` в `files` — обход не удался или путей нет: тогда ссылки не сверяем,
   * а не объявляем их битыми (§ «неполный список = подсказка врёт»).
   */
  private pathsCache: (ProjectPaths & { root: string }) | null = null;

  /**
   * Что из правил проекта ушло в последний `build`. Запоминаем здесь, а не
   * возвращаем вторым значением: `build` зовут в одном месте, а видно это
   * человеку в ленте и в сведениях о беседе — через след прогона.
   */
  private applied: AppliedInstruction[] = [];

  /** Правила проекта, показанные модели в последнем `build` (см. `applied`). */
  appliedInstructions(): readonly AppliedInstruction[] {
    return this.applied;
  }

  /** Файлы и каталоги проекта относительно корня: для проверки ссылок в правилах. */
  async projectFiles(root: string): Promise<ProjectPaths & { root: string }> {
    if (this.pathsCache?.root === root) return this.pathsCache;
    try {
      const { files, dirs, truncated } = await listProjectFiles(root);
      this.pathsCache = { root, files, dirs, truncated };
      return this.pathsCache;
    } catch {
      // Прочитать не смогли — проверять ссылки нельзя: пустой список выглядел бы
      // как «в проекте ничего нет», и все адреса в правилах стали бы битыми.
      this.pathsCache = { root, files: [], dirs: [], truncated: true };
      return this.pathsCache;
    }
  }

  /**
   * Карта проекта для промпта: устройство проекта по именам файлов. Пустая
   * папка, ошибка обхода — карта не добавляется, но правила проекта всё равно
   * читаются: без карты агент просто спросит её инструментом.
   */
  async mapLine(root: string): Promise<string | null> {
    if (this.mapCache?.root === root) return this.mapCache.text;
    try {
      const text = formatShortMap(await scanProject(root));
      this.mapCache = { root, text };
      return text;
    } catch {
      return null;
    }
  }

  /**
   * Версия файла для сверки памяти чтений: `mtimeMs:size` или `undefined`, если
   * сосчитать нельзя (нет файла, каталог). Зовётся только для покрытия, помеченного
   * сомнительным, — то есть после `terminal`, а не на каждом чтении.
   */
  async versionOf(target: string): Promise<string | undefined> {
    try {
      const stat = await this.workspace.stat(target);
      return stat.kind === 'file' ? readStamp(stat) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Системный блок перед беседой: папка, карта, память, правила проекта.
   *
   * `options.folder` — папка, с которой агент работает сейчас (от корня, `''` — корень).
   * От неё зависит, какие правила и навыки видны: ближайшие вверх по дереву побеждают.
   */
  async build(withMap: boolean, options: { folder?: string } = {}): Promise<string | null> {
    const root = this.workspace.rootPath();
    if (!root) return null;
    this.applied = [];

    const parts = [`Рабочая папка проекта: ${root}`];
    if (withMap) {
      const map = await this.mapLine(root);
      if (map) parts.push(map);
    }
    // Память — рядом с картой: заметки агента переживают беседу и её сжатие, поэтому
    // их видно в начале каждого ответа. Областей две: заметки проекта и общие — идут
    // отдельными блоками, чтобы агент не принял глобальную заметку за проектную.
    const memory = formatMemory(await this.memory.list(root, 'workspace'), 'workspace');
    if (memory) parts.push(memory);
    const globalMemory = formatMemory(await this.memory.list(root, 'global'), 'global');
    if (globalMemory) parts.push(globalMemory);
    let spent = 0;
    // Пути проекта — один раз на все файлы правил: сверка ссылок нужна в каждом,
    // а обход дерева — один. Список путей ещё пригодится карте выше — так что берём
    // его здесь, а не до цикла: карта может быть выключена.
    let projectFiles: (ProjectPaths & { root: string }) | null = null;

    // Правила читаются не только из корня: `src/AGENTS.md` действует в `src` и ниже.
    // Набор зависит от рабочей папки — что видит агент, то он и знает.
    const folder = options.folder ?? '';
    const folders = instructionFoldersFor(folder, (dir: string) => {
      try {
        return existsSync(path.join(root, dir)) && statSync(path.join(root, dir)).isDirectory();
      } catch {
        return false;
      }
    });

    // Порядок важен: корень первым, вложенные — после него. При противоречии побеждает
    // ближайший к работе файл; это прямо сказано в пометке при каждом подпапочном блоке.
    for (const dir of folders) {
      for (const name of INSTRUCTION_FILES) {
        if (spent >= MAX_INSTRUCTIONS_TOTAL_BYTES) break;
        const shownAs = dir ? `${dir}/${name}` : name;
        try {
          const text = await fs.readFile(path.join(root, dir, name), 'utf8');
          if (!text.trim()) continue;

          // Правила сверх общего потолка не теряем целиком: длинный файл едет
          // головой и картой разделов — по ней видно, что дальше, и есть чем
          // попросить продолжение (`read`/`search` по этому файлу).
          const room = Math.min(MAX_INSTRUCTIONS_BYTES, MAX_INSTRUCTIONS_TOTAL_BYTES - spent);
          parts.push(formatInstructionFile(shownAs, text, room, dir));
          this.applied.push(appliedInstruction(shownAs, text, room));
          spent += Math.min(text.length, room);

          // Битые ссылки ищем по ВСЕМУ файлу, а не по показанной голове: в отброшенный
          // хвост модель всё равно ходит через `read`, и мёртвый адрес там так же врёт.
          projectFiles ??= await this.projectFiles(root);
          // Каталоги передаём вместе с файлами: в правилах ссылаются и на
          // `src/shared`, а без `dirs` такой адрес объявлялся бы мёртвым.
          // `truncated` идёт вместе с путями: по обрезанному потолком списку
          // проверять нельзя — иначе правило с верным адресом объявляется битым.
          const broken = findBrokenLinks(text, {
            files: projectFiles.files,
            dirs: projectFiles.dirs,
            truncated: projectFiles.truncated,
          });
          const warning = describeBrokenLinks(shownAs, broken);
          if (warning) parts.push(warning);
        } catch {
          // файла нет — это нормально
        }
      }
    }

    // Навыки — после правил: правила действуют всегда, а навык подгружается по
    // надобности. Здесь только каталог (имя и строка): тело агент просит
    // инструментом `skill`, поэтому без инструментов каталог не добавляем —
    // прочитать навык будет нечем, и список станет обещанием без продолжения.
    if (withMap && this.skills) {
      const catalog = formatSkillCatalog(await this.skills.list(), { folder });
      if (catalog) parts.push(catalog);
    }
    return parts.join('\n\n');
  }
}
