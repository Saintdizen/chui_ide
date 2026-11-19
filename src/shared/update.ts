/** Результат проверки выпуска: тип общий для main и контракта RPC, поэтому `shared`. */
export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface UpdateCheckResult {
  /** Версия последнего выпуска без ведущей `v`; `null` — узнать не удалось. */
  latest: string | null;
  /** Страница выпуска — для кнопки «открыть в браузере». */
  pageUrl: string | null;
  /** Файлы, подходящие этой платформе и архитектуре. */
  assets: ReleaseAsset[];
}

export interface DownloadResult {
  /** Готовый файл на диске. */
  path: string;
  /** Человеку показать: имя файла без каталога. */
  name: string;
}
