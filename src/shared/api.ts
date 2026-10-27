/**
 * Единственный контракт между main- и renderer-процессами.
 *
 * Здесь: каналы IPC, доменные типы и таблица RPC-методов (ChuiMethods).
 * Файл попадает и в Node, и в браузер, поэтому импортировать сюда electron/node нельзя.
 */

export * from './api/channels';
export * from './api/transport';
export * from './api/app';
export * from './api/fs';
export * from './api/window';
export * from './api/terminal';
export * from './api/git';
export * from './api/settings';
export * from './api/python';
export * from './api/lsp';
export * from './api/debug';
export * from './api/ai';
export * from './api/rpc';
