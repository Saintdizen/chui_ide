import { ChatStreamEvent } from '../../shared/api/ai';

/**
 * Заслон от повторов событий прогона.
 *
 * Откуда повтор берётся. Поток идёт по одному `call.id`, и транспорт сам его не
 * дублирует (`RpcClient` снимает слушателя в `finally`). Но событие может прийти
 * дважды по другой причине: main повторил шаг после ошибки, слушатель подписан
 * дважды после смены вкладки, прогон продолжен по цели и начал шаг с тем же
 * номером. Отрисовка об этом не знает и просто делает своё дело — и в ленте
 * встают две карточки одного вызова, а в ответе — два одинаковых абзаца.
 *
 * Правило простое: событие, которое несёт идентичность, применяется один раз.
 * Текстовые куски (`delta`, `reasoning`) идентичности не несут — их повторы
 * отличаются от повторов настоящих по смыслу неотличимо, и склеивать их тут
 * значило бы гадать. Зато у вызова инструмента есть `id`, у шага — `index`,
 * у плана — сам план, у паузы — её значение.
 */
export interface StreamDedupe {
  /** Стоит ли принимать событие. `false` — такой уже был. */
  accept(event: string, payload: unknown): boolean;
  /** Прогон кончился — забыть всё: следующий начнётся с теми же номерами. */
  reset(): void;
}

export function createStreamDedupe(): StreamDedupe {
  /** Уже виденные вызовы: `tool_start` по `id`. */
  const started = new Set<string>();
  /** Итоги: `tool_result` по `id` — его может не быть, если вызов упал. */
  const finished = new Set<string>();
  /** Шаги отдаются вперёд: повтор `step` — тот же или меньший номер. */
  let lastStep = 0;
  /** План: тот же список шагов второй раз ничего не меняет в ленте. */
  let lastPlan = '';
  /** Последнее состояние паузы и цели: `paused: true` дважды — одно и то же. */
  let lastPaused: boolean | null = null;
  let lastGoal = '';

  return {
    accept(event, payload) {
      switch (event) {
        case ChatStreamEvent.ToolStart: {
          const id = (payload as { id?: unknown }).id;
          if (typeof id !== 'string') return true;
          if (started.has(id)) return false;
          started.add(id);
          return true;
        }
        case ChatStreamEvent.ToolResult: {
          const id = (payload as { id?: unknown }).id;
          if (typeof id !== 'string') return true;
          // Итог без начала — не повтор, а потеря: карточки нет, но счёт
          // изменений и артефакты из результата взять надо — поэтому пропускаем.
          if (finished.has(id)) return false;
          finished.add(id);
          return true;
        }
        case ChatStreamEvent.Step: {
          const index = (payload as { index?: unknown }).index;
          if (typeof index !== 'number') return true;
          // Шаг назад не ходит. Равный — тоже повтор: лента уже сказала
          // «шаг 7 из 24», говорить то же второй раз незачем.
          if (index <= lastStep) return false;
          lastStep = index;
          return true;
        }
        case ChatStreamEvent.Plan: {
          const steps = (payload as { steps?: unknown }).steps;
          // План — массив шагов: сравниваем по содержимому, порядок важен.
          const key = JSON.stringify(steps ?? null);
          if (key === lastPlan) return false;
          lastPlan = key;
          return true;
        }
        case ChatStreamEvent.Paused: {
          const paused = (payload as { paused?: unknown }).paused === true;
          if (paused === lastPaused) return false;
          lastPaused = paused;
          return true;
        }
        case ChatStreamEvent.Goal: {
          const goal = (payload as { goal?: unknown }).goal ?? null;
          const continued = (payload as { continued?: unknown }).continued ?? null;
          // Цель и число продолжений вместе: `goal` без изменений — повтор.
          const key = JSON.stringify([goal, continued]);
          if (key === lastGoal) return false;
          lastGoal = key;
          return true;
        }
        default:
          // `delta`, `reasoning`, `interject`: идентичности нет — пропускаем всё.
          return true;
      }
    },
    reset() {
      started.clear();
      finished.clear();
      lastStep = 0;
      lastPlan = '';
      lastPaused = null;
      lastGoal = '';
    },
  };
}
