/**
 * Переход к определению и поиск ссылок: от запроса к серверу — до перехода.
 *
 * Языковой сервер отвечает на переход списком мест, и с ним надо что-то решить: одно
 * место — перейти сразу, несколько — показать списком, ни одного — сказать об этом.
 * Это решение и есть весь модуль; сам запрос — дело `LspFeatures`, показ — `LocationsWidget`,
 * открытие файла — вызывающего (в приложении это `app`).
 *
 * Почему отдельно от вида: правило «одно — прыжок, много — список» — чистая функция
 * (`planNavigation`), её видно в тестах без окна и без сети. Класс сбоку лишь связывает
 * её с попапом и переходами, поэтому и живёт у хозяина панели, а не у вида.
 *
 * Ошибка сервера не повод падать: `LspFeatures` на сбой отдаёт пустой список, и сюда
 * это приходит как «мест нет» — попап не показывается, человек получает сообщение.
 */

import type { SymbolLocation } from '../../../shared/lsp-locations';
import { uniqueLocations } from '../../../shared/lsp-locations';
import type { EditorChange } from '../input/editor-controller';
import type { LocationRow, LocationsAnchor, LocationsWidget } from '../widgets/locations-widget';

/** Источник мест символа: по сути — `LspFeatures`, но без привязки к `rpc`. */
export interface SymbolSource {
  definition(path: string, position: { line: number; column: number }): Promise<SymbolLocation[]>;
  references(path: string, position: { line: number; column: number }): Promise<SymbolLocation[]>;
}

/** Что именно ищем — от этого зависит только подпись попапа и текст сообщения. */
export type NavigationKind = 'definition' | 'references';

/** Что делать с найденными местами. */
export type NavigationPlan =
  | { kind: 'none' }
  | { kind: 'jump'; target: SymbolLocation }
  | { kind: 'list'; targets: SymbolLocation[] };

/**
 * Решение по списку мест: одно — прыгаем, несколько — показываем списком, ни одного —
 * сообщаем. Повторы убираем заранее: один и тот же переход дважды — это не список.
 */
export function planNavigation(locations: readonly SymbolLocation[]): NavigationPlan {
  const unique = uniqueLocations(locations);
  if (unique.length === 0) return { kind: 'none' };
  if (unique.length === 1) return { kind: 'jump', target: unique[0]! };
  return { kind: 'list', targets: unique };
}

/** Строки списка мест: подпись даёт вызывающий (короткий путь), остальное — сами места. */
export function locationRows(
  locations: readonly SymbolLocation[],
  label: (target: SymbolLocation) => string,
): LocationRow[] {
  return locations.map((target) => ({
    label: label(target),
    detail: `${target.line}:${target.column}`,
    target,
  }));
}

export interface SymbolNavigationDeps {
  /** Откуда берём места символа. */
  source: SymbolSource;
  /** Куда показывать список. */
  widget: LocationsWidget;
  /** Где стоит каретка — у неё показываем список (система окна). */
  anchor(): LocationsAnchor;
  /** Перейти к месту: открыть файл и поставить курсор. Дело вызывающего. */
  reveal(target: SymbolLocation): void;
  /** Короткая подпись места в списке. */
  label(target: SymbolLocation): string;
  /** Сказать, что мест не нашлось. */
  notice(text: string): void;
  /** Путь и позиция курсора сейчас: с них уходит запрос к серверу. */
  position(): { path: string | null; line: number; column: number };
}

/**
 * Связка «сервер → решение → попап»: два входа (перейти к определению, найти ссылки) и
 * один список мест. Оба входа асинхронны (сервер в другом процессе), поэтому наружу они
 * возвращают ничего — результат виден в переходе или попапе, а не в возврате.
 */
export class SymbolNavigation {
  private readonly deps: SymbolNavigationDeps;

  constructor(deps: SymbolNavigationDeps) {
    this.deps = deps;
    // Выбор строки — общий для мыши и Enter: попап сам зовёт `onAccept`.
    deps.widget.onAccept = () => {
      const row = deps.widget.current;
      deps.widget.hide();
      if (row) deps.reveal(row.target);
    };
  }

  /** Перейти к определению символа под курсором. */
  goToDefinition(): void {
    void this.run('definition');
  }

  /** Показать ссылки на символ под курсором. */
  findReferences(): void {
    void this.run('references');
  }

  /** Список виден — клавиши принадлежат ему (ввод спрашивает об этом первым). */
  handleKey(event: KeyboardEvent): boolean {
    return this.deps.widget.handleKey(event);
  }

  /** Текст или курсор изменились: список про прежнее место больше не годится. */
  onChange(_change: EditorChange): void {
    this.hide();
  }

  hide(): void {
    this.deps.widget.hide();
  }

  private async run(kind: NavigationKind): Promise<void> {
    const { path, line, column } = this.deps.position();
    if (!path) return;

    let locations: SymbolLocation[];
    try {
      locations = await (kind === 'definition'
        ? this.deps.source.definition(path, { line, column })
        : this.deps.source.references(path, { line, column }));
    } catch {
      this.deps.notice(kind === 'definition' ? 'Не удалось перейти к определению' : 'Не удалось найти ссылки');
      return;
    }

    const plan = planNavigation(locations);
    if (plan.kind === 'none') {
      this.deps.notice(kind === 'definition' ? 'Определение не найдено' : 'Ссылок не найдено');
      return;
    }
    if (plan.kind === 'jump') {
      this.deps.reveal(plan.target);
      return;
    }

    this.deps.widget.show(
      kind === 'definition' ? 'Определения' : 'Ссылки',
      locationRows(plan.targets, this.deps.label),
      this.deps.anchor(),
    );
  }
}
