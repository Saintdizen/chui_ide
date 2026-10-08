import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  RpcErrorCode,
  type ChatMessage,
  type ChatRequest,
  type ChatStreamDone,
} from '../../shared/api';
import { RpcFailure } from '../ipc/router';
import type { SettingsStore } from '../settings';
import type { WorkspaceService } from '../workspace/workspace';
import { OpenAiCompatibleProvider } from './openai-compatible';
import type { AiProvider } from './provider';

/** Файлы с инструкциями проекта — подмешиваются в системный промпт. */
const INSTRUCTION_FILES = ['AGENTS.md', 'CHUI.md', 'CLAUDE.md'];
const MAX_INSTRUCTIONS_BYTES = 8000;

/**
 * AI-слой. Пока умеет одно: стримить ответ модели в renderer.
 * Агентный цикл с инструментами (см. shared/tools.ts) надстраивается сюда же —
 * все нужные примитивы уже есть: стрим событий, AbortSignal и реестр команд.
 */
export class AiService {
  constructor(
    private readonly settings: SettingsStore,
    private readonly workspace: WorkspaceService,
  ) {}

  async models(providerId: string, signal?: AbortSignal): Promise<string[]> {
    return this.createProvider(providerId).listModels(signal);
  }

  async chat(
    request: ChatRequest,
    emit: (event: string, payload: unknown) => void,
    signal: AbortSignal,
  ): Promise<ChatStreamDone> {
    const settings = this.settings.get();
    const provider = this.createProvider(request.providerId);

    const messages: ChatMessage[] = [];
    const systemPrompt = request.systemPrompt ?? settings.ai.systemPrompt;
    if (systemPrompt.trim()) messages.push({ role: 'system', content: systemPrompt });

    const context = await this.buildWorkspaceContext();
    if (context) messages.push({ role: 'system', content: context });

    messages.push(...request.messages);

    return provider.streamChat(
      {
        model: request.model,
        messages,
        temperature: request.temperature ?? settings.ai.temperature,
        maxTokens: request.maxTokens ?? settings.ai.maxTokens,
      },
      { onDelta: (text) => emit('delta', { text }) },
      signal,
    );
  }

  private createProvider(providerId: string): AiProvider {
    const provider = this.settings.get().ai.providers.find((item) => item.id === providerId);
    if (!provider) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, `Провайдер не найден: ${providerId}`);
    }

    const apiKey = this.settings.resolveApiKey(providerId);
    if (!apiKey && !isLocalEndpoint(provider.baseUrl)) {
      throw new RpcFailure(
        RpcErrorCode.InvalidParams,
        `Не задан API-ключ для «${provider.label}». Укажите его в панели AI или в settings.json`,
      );
    }

    return new OpenAiCompatibleProvider({
      id: provider.id,
      label: provider.label,
      baseUrl: provider.baseUrl,
      apiKey,
    });
  }

  private async buildWorkspaceContext(): Promise<string | null> {
    const root = this.workspace.rootPath();
    if (!root) return null;

    const parts = [`Рабочая папка проекта: ${root}`];
    for (const name of INSTRUCTION_FILES) {
      try {
        const text = await fs.readFile(path.join(root, name), 'utf8');
        if (text.trim()) {
          parts.push(`Инструкции из ${name}:\n${text.slice(0, MAX_INSTRUCTIONS_BYTES)}`);
          break;
        }
      } catch {
        // файла нет — это нормально
      }
    }
    return parts.join('\n\n');
  }
}

function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(url.hostname);
  } catch {
    return false;
  }
}
