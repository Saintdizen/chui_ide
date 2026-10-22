import type { ToastKind, ToastOptions } from '../ui/toast';
import type { DefineCommand } from './command-args';

export interface AiCommandDeps {
  /** Мастер-выключатель AI: всё, что открывает чат, обязано его спросить. */
  aiEnabled(): boolean;
  /** Единый отказ «AI выключен» — один текст на все команды. */
  warnAiDisabled(): void;
  chat: {
    newChat(): unknown;
    openRunLog(): void;
    stop(): void;
    askAboutSelection(kind: 'explain' | 'fix'): Promise<void>;
  };
  /** Показать панель чата и поставить курсор в поле ввода. */
  revealChat(): void;
  toggleChat(): void;
  telemetryModal: { open(): Promise<void> | void };
  diagnoseHighlighting(): string | Promise<string>;
  showToast(message: string, kind?: ToastKind, options?: ToastOptions): void;
}

/**
 * Команды ассистента.
 *
 * Три правила, из которых здесь всё следует:
 * 1. Вход в чат (новый диалог, панель, окно редактора, «объясни») требует
 *    включённого AI — иначе человек получает живую на вид мёртвую панель.
 * 2. Диагностика (трасса, журнал, отчёт о подсветке) гейта НЕ имеет: разбирать
 *    прогон чаще всего и нужно тогда, когда AI уже выключили.
 * 3. Остановка генерации работает всегда: если она уже идёт, отменять её надо,
 *    даже если тумблер только что выключили.
 */
export function registerAiCommands(define: DefineCommand, deps: AiCommandDeps): void {
  const { chat, aiEnabled, warnAiDisabled, revealChat } = deps;

  define({ id: 'ai.highlightProbe', title: 'AI: диагностика подсветки кода', category: 'AI' }, async () => {
    const report = await deps.diagnoseHighlighting();
    console.info(`[chui] подсветка кода\n${report}`);
    deps.showToast('Отчёт о подсветке — в консоли (Ctrl+Shift+I)');
  });

  // Трасса и журнал — диагностика, а не работа с моделью: ни запросов, ни трат
  // они не делают. Гейт `aiEnabled()` здесь был бы вреден: "у меня не работает AI"
  // — самый частый повод сюда заглянуть, в том числе при выключенном тумблере.
  // Это не недоделка: не ставить сюда проверку мастера.

  define({ id: 'ai.newChat', title: 'Новый диалог', category: 'AI' }, () => {
    // revealChat сам откажет, если AI выключен: новый диалог в мёртвой панели
    // только выглядит работающим.
    if (!aiEnabled()) {
      warnAiDisabled();
      return;
    }
    revealChat();
    return chat.newChat();
  });

  define(
    {
      id: 'ai.runLog',
      title: 'Прогон агента: трасса',
      category: 'AI',
      keywords: ['прогон', 'run', 'trace', 'диагностика'],
    },
    // Без гейта по мастеру сознательно: трасса — это про уже случившееся, а
    // разбирать прогон чаще всего и нужно тогда, когда AI уже выключили.
    () => chat.openRunLog(),
  );

  define(
    {
      id: 'ai.telemetry',
      title: 'Журнал прогонов…',
      category: 'AI',
      keywords: ['телеметрия', 'telemetry', 'журнал', 'прогоны', 'диагностика'],
    },
    // То же, что и у трассы: читаем историю, а не зовём модель — запросов нет,
    // и запрещать нечего.
    () => void deps.telemetryModal.open(),
  );

  // Остановка работает независимо от мастера: если генерация уже идёт, а AI только что
  // выключили в настройках — отменить её всё равно надо. Прятать здесь нечего.
  define({ id: 'ai.stop', title: 'Остановить генерацию', category: 'AI' }, () => chat.stop());

  // Чат — единственный вход в AI, который был без мастера: с выключенным AI
  // открывалась панель с полем ввода, и первая же отправка падала в main.
  // Кнопка в тулбаре уже прячется по aiEnabled(), а команда пусть говорит правду.
  define({ id: 'ai.toggle', title: 'Ассистент: показать/скрыть', category: 'AI', keybinding: 'Ctrl+Shift+A' }, () => {
    if (!aiEnabled()) {
      warnAiDisabled();
      return;
    }
    deps.toggleChat();
  });


  define({ id: 'ai.explainSelection', title: 'Объяснить выделение', category: 'AI' }, async () => {
    // revealChat сам покажет «AI выключен», но `askAboutSelection` при этом всё равно
    // сходил бы в main за ответом, который никто не увидит.
    if (!aiEnabled()) {
      warnAiDisabled();
      return;
    }
    revealChat();
    await chat.askAboutSelection('explain');
  });

  define({ id: 'ai.fixSelection', title: 'Исправить выделение', category: 'AI' }, async () => {
    if (!aiEnabled()) {
      warnAiDisabled();
      return;
    }
    revealChat();
    await chat.askAboutSelection('fix');
  });
}
