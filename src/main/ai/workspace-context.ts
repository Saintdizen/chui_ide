import fs from 'node:fs/promises';
import path from 'node:path';

import { formatInstructionFile } from '../../shared/instructions';
import { formatMemory } from '../../shared/memory';
import { formatShortMap } from '../../shared/project-map';
import { scanProject } from '../project/scan';
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
  ) {}

  /**
   * Скан обходит дерево, поэтому держим результат до смены папки: в каждом
   * запросе обходить проект заново — платить за одно и то же. Числа поэтому
   * могут отстать от жизни (агент что-то создал) — за свежими он идёт в
   * `project_map`, который сканирует на каждый вызов.
   */
  private mapCache: { root: string; text: string } | null = null;

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

  /** Системный блок перед беседой: папка, карта, память, правила проекта. */
  async build(withMap: boolean): Promise<string | null> {
    const root = this.workspace.rootPath();
    if (!root) return null;

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
    for (const name of INSTRUCTION_FILES) {
      if (spent >= MAX_INSTRUCTIONS_TOTAL_BYTES) break;
      try {
        const text = await fs.readFile(path.join(root, name), 'utf8');
        if (!text.trim()) continue;

        // Правила сверх общего потолка не теряем целиком: длинный файл едет
        // головой и картой разделов — по ней видно, что дальше, и есть чем
        // попросить продолжение (`read_file`/`search` по этому файлу).
        const room = Math.min(MAX_INSTRUCTIONS_BYTES, MAX_INSTRUCTIONS_TOTAL_BYTES - spent);
        parts.push(formatInstructionFile(name, text, room));
        spent += Math.min(text.length, room);
      } catch {
        // файла нет — это нормально
      }
    }
    return parts.join('\n\n');
  }
}
