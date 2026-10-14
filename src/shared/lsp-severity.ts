/**
 * Насколько серьезна пометка языка — с поправкой на код правила.
 *
 * Языковой сервер сам решает, что у него `error`, а что `warning`, и это решение не
 * всегда совпадает с тем, что человек называет ошибкой. Живой случай: pyright
 * помечает `error` переопределение имени в наследнике
 * (`reportIncompatibleVariableOverride`) — подчёркивание красное, а по сути это
 * замечание о стиле: код работает. Красное под каждым таким местом обесценивает
 * настоящие ошибки — глаз перестаёт их различать.
 *
 * Поэтому у нас есть короткий список правил, которые сервер шлёт как ошибку, а мы
 * показываем предупреждением (жёлтым). Список маленький и явный, а не «всё, где есть
 * слово report»: понижать надо осознанно, по одному правилу, иначе можно спрятать
 * настоящую ошибку. Настоящие ошибки (`reportGeneralTypeIssues`, `E501` у ruff и прочие)
 * остаются красными.
 *
 * Модуль чистый: на входе степень и код, на выходе степень. Поэтому список виден в тестах.
 */

import type { LspDiagnostic } from './api';

/**
 * Правила, которые показываем предупреждением, хотя сервер шлёт их ошибкой.
 *
 * Здесь только то, что говорит о СТИЛЕ и совместимости, а не о работоспособности кода:
 *   • переопределение имени/метода в наследнике другим типом (pyright считает ошибкой,
 *     PyCharm — предупреждением или не замечает вовсе);
 *   • необъявленный/неизвестный тип при строгом режиме — шум в проекте без аннотаций;
 *   • лишние конструкции и устаревшее использование — замечания, а не поломки.
 */
const STYLE_RULES: ReadonlySet<string> = new Set([
  'reportIncompatibleVariableOverride',
  'reportIncompatibleMethodOverride',
  'reportIncompatibleVariableOverride#',
  'reportUnknownMemberType',
  'reportUnknownArgumentType',
  'reportUnknownVariableType',
  'reportUnknownParameterType',
  'reportUnknownLambdaType',
  'reportUnnecessaryIsInstance',
  'reportUnnecessaryCast',
  'reportUnnecessaryComparison',
  'reportUnusedImport',
  'reportUnusedClass',
  'reportUnusedFunction',
  'reportUnusedVariable',
  'reportPrivateUsage',
  'reportImportCycles',
  'reportDeprecated',
  'reportMissingTypeStubs',
  'reportMissingModuleSource',
]);

/**
 * Степень пометки с поправкой на правило. Ошибка «стилевого» правила становится
 * предупреждением; всё остальное — как сказал сервер.
 */
export function downgradeSeverity(
  severity: LspDiagnostic['severity'],
  code: string | undefined,
): LspDiagnostic['severity'] {
  if (severity !== 'error' || !code) return severity;
  // Код приходит и как `reportX`, и как `reportX#value` (у части серверов) — берём до `#`.
  const rule = code.split('#')[0] ?? code;
  return STYLE_RULES.has(rule) ? 'warning' : severity;
}
