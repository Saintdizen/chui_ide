// У monaco-editor есть карта экспортов вида "./*" → "./esm/vs/*",
// поэтому глубокие пути пишутся без префикса esm/vs — иначе пакет
// подставит его дважды и сборка не найдёт модуль.
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import cssWorker from 'monaco-editor/language/css/css.worker.js?worker';
import htmlWorker from 'monaco-editor/language/html/html.worker.js?worker';
import jsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';

interface MonacoEnvironmentShape {
  getWorker(workerId: string, label: string): Worker;
}

/**
 * Monaco выполняет подсветку, форматирование и TS-сервисы в web worker'ах.
 * Vite собирает их через `?worker`, поэтому здесь только выбор нужного.
 * Тип берём свой: monaco объявляет MonacoEnvironment по-разному в разных версиях.
 */
const environment: MonacoEnvironmentShape = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new jsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker();
      case 'typescript':
      case 'javascript':
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

(globalThis as unknown as { MonacoEnvironment: MonacoEnvironmentShape }).MonacoEnvironment = environment;
