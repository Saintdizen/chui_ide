/**
 * Аргументы команд приходят из палитры, меню и от ассистента как `unknown`.
 * Здесь же — тип регистратора: им пользуются все вынесенные из `app.ts` группы.
 */
import type { CommandDescriptor } from './commands';

export const asPath = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

export type DefineCommand = (descriptor: CommandDescriptor, handler: (...args: unknown[]) => unknown) => void;
