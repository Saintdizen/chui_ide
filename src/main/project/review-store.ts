import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PROJECT_CONFIG_DIR } from '../project-config';
import { sanitizeReview, type ReviewThread } from '../../shared/review';

/**
 * Замечания к коду в файле `<root>/.chui_ide/review.json`.
 *
 * Почему в проекте, а не в userData: замечания — про ЭТОТ код, их видно в
 * репозитории, можно версионировать и передать коллеге вместе с проектом (как
 * проектные настройки рядом, `project-config.ts`). Формат терпимый: битый JSON и
 * незнакомые поля не роняют загрузку — модель проверяется в `shared/review.ts`.
 *
 * Источник истины — renderer: он собирает список и присылает сюда целиком; main лишь
 * читает и записывает. Поэтому проверка одна и та же на обоих концах.
 */
export class ReviewStore {
  /** Каталог конфигурации можно задать явно (проверки), иначе берётся из корня. */
  constructor(private readonly dirOverride?: string) {}

  private file(root: string): string {
    return path.join(this.dirOverride ?? path.join(root, PROJECT_CONFIG_DIR), 'review.json');
  }

  async load(root: string): Promise<ReviewThread[]> {
    if (!root) return [];
    try {
      const raw: unknown = JSON.parse(await fs.readFile(this.file(root), 'utf8'));
      return sanitizeReview(raw);
    } catch {
      // Нет файла или он повреждён — просто нет замечаний, а не ошибка открытия.
      return [];
    }
  }

  /** Записать список целиком и вернуть то, что легло на диск (уже проверенное). */
  async save(root: string, threads: readonly ReviewThread[]): Promise<ReviewThread[]> {
    const clean = sanitizeReview(threads);
    if (!root) return clean;
    const file = this.file(root);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ version: 1, threads: clean }, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, file);
    return clean;
  }
}
