/**
 * Ошибка прогона глазами человека: не `HTTP 429 after 4 attempts`, а что это
 * значит и что с этим делать.
 *
 * Зачем отдельный модуль. Текст ошибки нéсёт две службы сразу: его читают в
 * ленте и по нему решают, нажимать ли «Повторить». Смешивать это в одном
 * месте нельзя — в ленте нужен смысл, а в логике — признак «повторять есть
 * смысл или деньги на ветер».
 *
 * Модуль чистый: на вход — сообщение и код, на выход — заголовок, пояснение и
 * стоит ли предлагать повтор.
 */

export type FailureKind =
  /** Сеть: до провайдера не достучались. Повтор обычно помогает. */
  | 'network'
  /** Провайдер перегружен или просит подождать. Повтор помогает, но не сразу. */
  | 'busy'
  /** Ключ, доступ, оплата. Повтор бессмыслен: пока не починят настройки. */
  | 'access'
  /** Модель не найдена или не поддержана этим провайдером. */
  | 'model'
  /** Контекст не влез даже после сжатия. Повтор тем же вопросом упрётся снова. */
  | 'context'
  /** Всё остальное: не угадываем, но и не врём, что знаем причину. */
  | 'other';

export interface RunFailure {
  kind: FailureKind;
  /** Одна строка для ленты: что случилось. */
  title: string;
  /** Что можно сделать — коротко и по делу. */
  hint: string;
  /** Показывать ли «Повторить». Скрывать кнопку из вежливости — хуже: она нужна тогда, когда помогает. */
  retryable: boolean;
}

/**
 * Признаки ищутся по тексту: провайдеры не договорились об общем формате, а
 * код ответа до нас доходит только внутри сообщения.
 */
function detect(raw: string): FailureKind {
  const text = raw.toLowerCase();
  if (
    /40[13]|unauthori[sz]ed|forbidden|api[ _-]?key|invalid[_ ]key|неверн\p{Alpha}* ключ|биллинг|billing|quota|insufficient[_ ](funds|quota)/u.test(
      text,
    )
  ) {
    return 'access';
  }
  if (/429|rate[ _-]?limit|too many requests|слишком много запросов|overloaded|перегруз/u.test(text)) {
    return 'busy';
  }
  if (/model[_ ]not[_ ]found|no such model|unknown model|unsupported model|модель не найдена/u.test(text)) {
    return 'model';
  }
  if (/context[_ ](length|window)|too many tokens|maximum context|контекст/u.test(text)) {
    return 'context';
  }
  if (
    /econnrefused|etimedout|enotfound|econnreset|network|fetch failed|socket|offline|нет сети|не удалось соединиться/u.test(
      text,
    )
  ) {
    return 'network';
  }
  return 'other';
}

const KNOWN: Record<Exclude<FailureKind, 'other'>, Omit<RunFailure, 'kind'>> = {
  network: {
    title: 'Нет связи с провайдером',
    hint: 'Проверьте сеть и нажмите «Повторить» — вопрос не потерян.',
    retryable: true,
  },
  busy: {
    title: 'Провайдер перегружен',
    hint: 'Запрос не прошёл из-за лимита или нагрузки. Подождите немного и повторите.',
    retryable: true,
  },
  access: {
    title: 'Нет доступа к провайдеру',
    hint: 'Проверьте ключ и оплату в настройках — повтор без этого не поможет.',
    retryable: false,
  },
  model: {
    title: 'Модель недоступна',
    hint: 'Выберите другую модель в настройках провайдера.',
    retryable: false,
  },
  context: {
    title: 'Не хватает контекста',
    hint: 'Сократите вопрос или начните новую беседу: в этой уже не помещается.',
    retryable: false,
  },
};

/**
 * Разбор неудачного прогона. `cancelled` проверяем первым: остановку руками
 * нельзя выдавать за ошибку провайдера — человек сам этого и хотел.
 */
export function classifyFailure(message: string, cancelled = false): RunFailure | null {
  // Остановку руками разбирать не надо: у неё нет причины и нечего советовать.
  if (cancelled) return null;
  const kind = detect(message);
  if (kind === 'other') {
    return {
      kind,
      title: 'Не удалось получить ответ',
      // Сырой текст не выбрасываем: без него не пожалуешься и не поищешь причину.
      // Но и за совет его не выдаём — просто показываем как есть.
      hint: message.trim() || 'Провайдер не сообщил причину.',
      retryable: true,
    };
  }
  return { kind, ...KNOWN[kind] };
}
