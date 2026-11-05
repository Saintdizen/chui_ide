/**
 * Горячие клавиши: что можно изменить и как это хранится.
 *
 * Сочетания по умолчанию заданы в коде (`renderer/core/default-keybindings.ts`) — там
 * их видит и служба перехвата, и редактор сочетаний в настройках. Человек может
 * переопределить любое: переопределения лежат в настройках рядом с прочими и
 * накладываются на сочетания по умолчанию. Правит файл и форма, поэтому значение
 * проверяется (`normalizeKeybindingOverrides`).
 *
 * Сочетаний два сорта, и живут они в разных процессах:
 *
 *   • у пунктов меню клавишу держит Electron (`shared/app-menu.ts`), и нажатие
 *     обрабатывает main — пункт шлёт команду push-событием;
 *   • остальные (то, чего в меню нет) перехватывает сам renderer
 *     (`KeybindingService`) по `default-keybindings.ts`.
 *
 * Одна и та же команда бывает с клавишей И в меню, И в renderer (терминал: `Alt+F12`
 * из меню и ``Ctrl+` `` — привычное сочетание). Поэтому переопределение адресуется
 * не только командой, но и родом клавиши: у меню впереди стоит `menu:`
 * (`menu:file.save`). Так правка клавиши меню не сбивает свою клавишу renderer у той
 * же команды, и наоборот.
 */

/** Переопределение сочетания для одной команды. */
export interface KeybindingOverride {
  /** Команда (идентификатор из реестра) либо `menu:<команда>` для акселератора меню. */
  command: string;
  /** Сочетание, например `Ctrl+Shift+K`. Пустая строка — сочетание снято. */
  combo: string;
}

/** Настройки сочетаний: только то, что человек изменил сам. */
export interface KeybindingSettings {
  overrides: KeybindingOverride[];
}

/** Команда и сочетание — обе строки, непустая только команда. */
function isOverride(value: unknown): value is KeybindingOverride {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as { command?: unknown; combo?: unknown };
  return typeof item.command === 'string' && item.command.length > 0 && typeof item.combo === 'string';
}

/**
 * Привести список переопределений из настроек к известному виду: только объекты с
 * командой и строкой сочетания, по одному на команду (последнее выигрывает).
 */
/** Приставка к команде, которой адресуется клавиша пункта меню. */
export const MENU_BINDING_PREFIX = 'menu:';

/** Ключ переопределения для акселератора меню команды. */
export function menuBindingId(command: string): string {
  return `${MENU_BINDING_PREFIX}${command}`;
}

/** Это переопределение клавиши меню (а не сочетания самого renderer). */
export function isMenuBinding(id: string): boolean {
  return id.startsWith(MENU_BINDING_PREFIX);
}

/** Команда из ключа переопределения меню. Для прочих ключей возвращает их сами. */
export function menuCommandOf(id: string): string {
  return isMenuBinding(id) ? id.slice(MENU_BINDING_PREFIX.length) : id;
}

/**
 * Переопределения клавиш МЕНЮ: карта `команда → сочетание`. Их читает main при
 * сборке меню. Ключи без приставки пропускаем — они принадлежат renderer.
 */
export function menuComboOverrides(overrides: readonly KeybindingOverride[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of overrides) {
    // Пустое сочетание у клавиши меню значит «снять»: Electron поймёт пустой `accelerator`.
    if (isMenuBinding(item.command)) map.set(menuCommandOf(item.command), item.combo);
  }
  return map;
}

/** Переопределения сочетаний renderer: клавиши меню из общего списка выпадают. */
export function rendererOverrides(overrides: readonly KeybindingOverride[]): KeybindingOverride[] {
  return overrides.filter((item) => !isMenuBinding(item.command));
}

/** Сочетание и команда — то, из чего ищутся столкновения. */
export interface BindingLike {
  readonly combo: string;
  readonly command: string;
}

/** Одно сочетание, занятое несколькими командами. */
export interface BindingConflict {
  readonly combo: string;
  readonly commands: string[];
}

/**
 * Сочетания, которые делят несколько команд. Одно сочетание у двух команд — почти
 * всегда описка: сработает первое, остальным достанется не то. Пустые сочетания
 * (снятые) не считаем. Порядок — по первому появлению сочетания, устойчивый.
 */
export function bindingConflicts(bindings: readonly BindingLike[]): BindingConflict[] {
  const used = new Map<string, string[]>();
  for (const binding of bindings) {
    if (!binding.combo) continue;
    const commands = used.get(binding.combo);
    if (commands) commands.push(binding.command);
    else used.set(binding.combo, [binding.command]);
  }
  const conflicts: BindingConflict[] = [];
  for (const [combo, commands] of used) {
    if (commands.length > 1) conflicts.push({ combo, commands: [...commands] });
  }
  return conflicts;
}

/** Откуда сочетание родом. */
export type BindingOrigin = 'renderer' | 'menu';

/** Одна строка редактора сочетаний — то, что видит человек и что решает спор. */
export interface BindingRow extends BindingLike {
  /** Ключ переопределения: `команда` либо `menu:команда`. */
  readonly id: string;
  readonly origin: BindingOrigin;
  /** Нынешнее сочетание — это НЕ встроенное, а выбранное человеком. */
  readonly isCustom: boolean;
  /**
   * Порядок применения: меньше — главнее. У встроенных он нулевой (их никто не
   * перебивает), у переопределений — «чем позже задано, тем главнее».
   */
  readonly order: number;
}

/**
 * Кто главнее, когда одно сочетание взяли две строки.
 *
 * Порядок не выдуман, а снят с того, как нажатие идёт по программе:
 *
 *   1. **Клавиша меню бьёт сочетание renderer.** Акселератор держит Electron и
 *      перехватывает нажатие раньше окна: событие до renderer просто не доходит.
 *      Поэтому сочетание вроде «Ctrl+`» из меню победит такое же сочетание в
 *      редакторе, что бы ни лежало в настройках.
 *   2. **Своё бьёт встроенное.** Переопределение потому и переопределение, что
 *      пришло после; человек нажал клавишу именно затем, чтобы она сработала.
 *   3. Дальше — `order`: последнее заданное главнее. У меню и renderer ключи
 *      разные, так что настройка может быть у каждого.
 */
function bindingOrder(row: BindingRow): number {
  const byOrigin = row.origin === 'menu' ? 0 : 10;
  return byOrigin + (row.isCustom ? 0 : 5) + row.order;
}

/** Команда (для меню — с приставкой), которая сработает по этому сочетанию. */
export interface BindingWinner {
  /** Ключ победившей строки: `команда` или `menu:команда`. */
  readonly id: string;
  /** Почему победила — человеческим языком, для показа рядом со спором. */
  readonly reason: string;
}

/** Разобранный спор: одно сочетание и все, кто на него заявился. */
export interface BindingDispute extends BindingConflict {
  /** Строки спора в порядке главенства: первая — та, что сработает. */
  readonly rows: BindingRow[];
  readonly winner: BindingWinner;
  /** Строки, которым достанется не то, что человек думал, — их и предлагаем развести. */
  readonly losers: BindingRow[];
}

/**
 * Разобрать столкновения по строкам редактора: кто сработает и почему.
 *
 * `bindingConflicts` отвечает на вопрос «что столкнулось», этот — на вопрос
 * «и что теперь будет». Человеку нужно второе: без него предупреждение «Ctrl+K
 * у двух команд» заставляет гадать, какая из них жива.
 *
 * Пустые сочетания и одинаковые сочетания у ОДНОЙ команды спором не считаются:
 * команда и клавиша меню у неё — разные строки, но итог один и тот же.
 */
export function bindingDisputes(rows: readonly BindingRow[]): BindingDispute[] {
  const byCombo = new Map<string, BindingRow[]>();
  for (const row of rows) {
    if (!row.combo) continue;
    const group = byCombo.get(row.combo);
    if (group) group.push(row);
    else byCombo.set(row.combo, [row]);
  }
  const disputes: BindingDispute[] = [];
  for (const [combo, group] of byCombo) {
    // Разные строки одной команды — не спор: какая бы ни сработала, команда та же.
    const commands = [...new Set(group.map((row) => menuCommandOf(row.id)))];
    if (commands.length < 2) continue;
    // Сортировка устойчивая: при равном порядке остаётся порядок в списке.
    const sorted = [...group].sort((a, b) => bindingOrder(a) - bindingOrder(b));
    const winnerRow = sorted[0]!;
    disputes.push({
      combo,
      commands,
      rows: sorted,
      winner: { id: winnerRow.id, reason: winnerReasonText(winnerRow) },
      losers: sorted.slice(1),
    });
  }
  return disputes;
}

/** Короткое «почему» для победившей строки. */
function winnerReasonText(row: BindingRow): string {
  if (row.origin === 'menu') {
    return row.isCustom
      ? 'клавиша меню, заданная вами: Electron перехватывает её раньше окна'
      : 'клавиша меню: Electron перехватывает её раньше окна';
  }
  return row.isCustom ? 'сочетание, заданное вами: оно перебивает встроенное' : 'встроенное сочетание';
}

/**
 * Кнопка «снять с пересечения»: пустое сочетание у всех проигравших строк.
 *
 * Именно пустое, а не «как было»: вернуть встроенное значение значило бы вернуть
 * тот же спор — встроенная клавиша меню и встроенная клавиша renderer столкнутся
 * снова. Снимаем и даём человеку назначить заново осознанно.
 */
export function bindingResolution(dispute: BindingDispute): { command: string; combo: string }[] {
  return dispute.losers.map((row) => ({ command: row.id, combo: '' }));
}

export function normalizeKeybindingOverrides(value: unknown): KeybindingOverride[] {
  if (!Array.isArray(value)) return [];
  const byCommand = new Map<string, string>();
  for (const item of value) {
    if (isOverride(item)) byCommand.set(item.command, item.combo.trim());
  }
  return [...byCommand.entries()].map(([command, combo]) => ({ command, combo }));
}
