import { Emitter } from './events';

export interface CommandDescriptor {
  id: string;
  title: string;
  category: string;
  /** Дополнительные слова для поиска в палитре: синонимы и аббревиатуры. */
  keywords?: readonly string[];
  /** Подсказка для UI; реальные акселераторы дублируются в меню приложения. */
  keybinding?: string;
  /**
   * Доступна ли команда прямо сейчас. Нет или `true` — всегда доступна, `false` —
   * пункт в палитре показан выключенным. Так команда, которой сейчас нечего
   * делать, заранее говорит об этом, вместо тоста «проект не открыт» после запуска.
   */
  enabled?: () => boolean;
}

export type CommandHandler = (...args: unknown[]) => unknown;

export interface CommandInvocation {
  id: string;
  args: unknown[];
}

/**
 * Реестр команд — центральная идея архитектуры.
 *
 * Любое действие (пункт меню, кнопка, будущий вызов инструмента ассистентом)
 * проходит через один и тот же вход. Из-за этого AI-ассистенту достаточно
 * вызвать команду по идентификатору: отдельного «AI-слоя доступа» не нужно.
 */
export class CommandRegistry {
  private readonly entries = new Map<string, { descriptor: CommandDescriptor; handler: CommandHandler }>();

  private readonly executeEmitter = new Emitter<CommandInvocation>();
  readonly onDidExecute = this.executeEmitter.event;

  register(descriptor: CommandDescriptor, handler: CommandHandler): () => void {
    this.entries.set(descriptor.id, { descriptor, handler });
    return () => this.entries.delete(descriptor.id);
  }

  get(id: string): CommandDescriptor | undefined {
    return this.entries.get(id)?.descriptor;
  }

  /** Доступна ли команда сейчас: палитра по этому решает, гасить ли пункт. */
  isEnabled(id: string): boolean {
    return this.entries.get(id)?.descriptor.enabled?.() ?? true;
  }

  list(): CommandDescriptor[] {
    return [...this.entries.values()].map((entry) => entry.descriptor);
  }

  async execute(id: string, ...args: unknown[]): Promise<unknown> {
    const entry = this.entries.get(id);
    if (!entry) {
      console.warn(`[chui] команда не найдена: ${id}`);
      return undefined;
    }
    const result = await entry.handler(...args);
    this.executeEmitter.fire({ id, args });
    return result;
  }
}
