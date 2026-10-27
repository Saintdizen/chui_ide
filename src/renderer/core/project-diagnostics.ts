import type { LspDiagnostic, LspProjectDiagnosticsPayload } from '../../shared/api';

/**
 * Пометки обхода проекта в окно.
 *
 * Источник отдельный (`lsp-project`), а не тот, что у живого сервера: файл нашёлся
 * обходом и закрылся, а сервер на закрытие отвечает пустым списком — если писать
 * в общий источник, счёт обнулялся бы сам. Живые пометки открытого файла всегда
 * свежее, поэтому обход их не касается (см. main: `collectDiagnostics`).
 */
export interface ProjectDiagnosticsDeps {
  /** Поставить пометки файла от обхода; пустой список — снять прежние. */
  setMarkers(path: string, diagnostics: LspDiagnostic[]): void;
}

/** Сколько файлов помечено прошлым обходом: снимать их на новом заходе. */
export function createProjectDiagnosticsApplier(
  deps: ProjectDiagnosticsDeps,
): (payload: LspProjectDiagnosticsPayload) => void {
  let swept: string[] = [];

  return (payload) => {
    // Новый обход: файлы, которых в нём не будет (удалённые, переименованные),
    // иначе оставили бы свои ошибки навсегда.
    if (payload.start) {
      for (const path of swept) deps.setMarkers(path, []);
      swept = [];
    }
    for (const file of payload.files) {
      deps.setMarkers(file.path, file.diagnostics);
      swept.push(file.path);
    }
  };
}
