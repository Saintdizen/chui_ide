import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { canonicalCall } from '../src/shared/tool-aliases';
import type { ChatUsage } from '../src/shared/api';
import { integerArg } from '../src/shared/tool-args';

export interface CensusCall {
  id?: string;
  name?: string;
  arguments?: string;
}
export interface CensusMessage {
  role?: string;
  content?: unknown;
  ok?: boolean;
  usage?: ChatUsage;
  toolCallId?: string;
  toolCalls?: CensusCall[];
}
interface ChatFile {
  conversations?: { messages?: CensusMessage[] }[];
}
export interface CensusManifest {
  version: 1;
  directory: string;
  files: { name: string; sha256: string }[];
}
const DEFAULT_DIR = join(homedir(), '.config/chui-ide/chats');
const LIVE_MS = 15 * 60 * 1000;
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Общая выборка: явный каталог включает всё, домашний исключает живые беседы. */
export function loadCensus(argv: string[] = process.argv.slice(2), now = Date.now()) {
  const option = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    if (at < 0) return undefined;
    const value = argv[at + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name}: нужен путь`);
    return value;
  };
  const manifestPath = option('--manifest');
  const writePath = option('--write-manifest');
  if (manifestPath && writePath) throw new Error('Выберите --manifest или --write-manifest');
  const positional = argv
    .filter((_, index) => index === 0 || !argv[index - 1]!.startsWith('--'))
    .filter((arg) => !arg.startsWith('--'));
  const directory = resolve(positional[0] ?? DEFAULT_DIR);
  let manifest: CensusManifest;
  if (manifestPath) {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CensusManifest;
    if (manifest.version !== 1 || !Array.isArray(manifest.files) || typeof manifest.directory !== 'string') {
      throw new Error('Неизвестный формат манифеста');
    }
  } else {
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      names = [];
    }
    manifest = {
      version: 1,
      directory,
      files: names
        .filter((name) => name.endsWith('.json') && !name.endsWith('.index.json'))
        .filter((name) => positional.length > 0 || now - statSync(join(directory, name)).mtimeMs >= LIVE_MS)
        .sort()
        .map((name) => ({ name, sha256: digest(readFileSync(join(directory, name), 'utf8')) })),
    };
  }
  const chats: { name: string; chat: ChatFile }[] = [];
  const skipped: string[] = [];
  for (const file of manifest.files) {
    if (typeof file.name !== 'string' || /[/\\]/.test(file.name) || !file.name.endsWith('.json')) {
      throw new Error('Недопустимое имя в манифесте');
    }
    const text = readFileSync(join(manifest.directory, file.name), 'utf8');
    if (digest(text) !== file.sha256) throw new Error(`Выборка изменилась: ${file.name}`);
    try {
      const chat = JSON.parse(text) as ChatFile;
      if (!Array.isArray(chat?.conversations)) throw new Error('Нет бесед');
      chats.push({ name: file.name, chat });
    } catch {
      skipped.push(file.name);
    }
  }
  if (writePath) writeFileSync(writePath, `${JSON.stringify(manifest, null, 2)}\n`);
  const messages = chats.flatMap(({ chat }) =>
    chat.conversations!.map((item) => canonicalMessages(item.messages ?? [])),
  );
  const calls = messages.flatMap((items) => items.flatMap((message) => message.toolCalls ?? [])).length;
  const results = messages.flatMap((items) => items.filter((message) => message.role === 'tool')).length;
  const fingerprint = digest(JSON.stringify(manifest)).slice(0, 16);
  const usage = { steps: 0, prompt: 0, cached: 0, completion: 0, cacheCreation: 0 };
  for (const message of messages.flat()) {
    if (message.role !== 'assistant' || !message.usage) continue;
    usage.steps += 1;
    usage.prompt += message.usage.promptTokens ?? 0;
    usage.cached += message.usage.cachedTokens ?? 0;
    usage.completion += message.usage.completionTokens ?? 0;
    usage.cacheCreation += message.usage.cacheCreationTokens ?? 0;
  }
  return { chats, messages, manifest, calls, results, skipped, fingerprint, usage };
}

/** Имя и аргументы переписываем вместе: иначе псевдонимы теряют action и форму правок. */
export function canonicalMessages(messages: CensusMessage[]): CensusMessage[] {
  return messages.map((message) => ({
    ...message,
    ...(message.toolCalls
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            ...call,
            ...canonicalCall(call.name ?? '', call.arguments ?? ''),
          })),
        }
      : {}),
  }));
}

export function censusHeader(sample: ReturnType<typeof loadCensus>): string {
  return `Выборка ${sample.fingerprint}: бесед-файлов ${sample.chats.length}, вызовов ${sample.calls}, результатов ${sample.results}, пропущено ${sample.skipped.length}. Токены — оценка текста, не стоимость API.\nUsage (только записанные ${sample.usage.steps} ответы): вход ${sample.usage.prompt}, кеш ${sample.usage.cached}, запись кеша ${sample.usage.cacheCreation}, выход ${sample.usage.completion}.`;
}

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : '')).join('');
}

/** Отказы не смешиваем с успешной пустой выдачей. */
export function isFailure(message: CensusMessage): boolean {
  if (typeof message.ok === 'boolean') return !message.ok;
  return (
    /^(?:Ошибка(?:\s|:|$)|Не хватает аргумента|Неизвестное значение аргумента)/u.test(textOf(message.content).trim()) ||
    /не входит\. Скажи человеку|код выхода [1-9]/u.test(textOf(message.content))
  );
}

export function argumentsOf(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readRangeOf(raw: string): { from: number; to: number; whole: boolean } {
  const args = argumentsOf(raw);
  const from = integerArg(args.startLine);
  const to = integerArg(args.endLine);
  return { from: Math.max(1, from ?? 1), to: to ?? Infinity, whole: from === undefined && to === undefined };
}

/** Только строки совпадений: контекст «42-» и filesOnly не считаются. */
export function searchHitCount(text: string): number {
  return text
    .split('\n')
    .filter((line) => !/^\s*\d+-/.test(line) && (/^\s*\d+:\s/.test(line) || /^.+:\d+:(?:\d+:)?\s?/.test(line))).length;
}

/** Следующий шаг после отказа — отдельно от нормальной серии команд. */
export function retryNames(messages: CensusMessage[], index: number): string[] {
  const following = messages
    .slice(index + 1)
    .find((message) => message.role === 'assistant' && message.toolCalls?.length);
  if (!following) return [];
  return [
    ...new Set(
      (messages[index]?.toolCalls ?? [])
        .filter((call) => {
          const result = call.id
            ? messages.slice(index + 1).find((item) => item.role === 'tool' && item.toolCallId === call.id)
            : undefined;
          return result && isFailure(result) && following.toolCalls!.some((next) => next.name === call.name);
        })
        .map((call) => call.name!),
    ),
  ];
}
