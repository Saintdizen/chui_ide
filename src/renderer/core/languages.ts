const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  vue: 'html',
  svelte: 'html',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  conf: 'ini',
  env: 'ini',
  xml: 'xml',
  svg: 'xml',
  sql: 'sql',
  lua: 'lua',
  dart: 'dart',
  r: 'r',
  pl: 'perl',
  scala: 'scala',
  gradle: 'groovy',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
};

const LANGUAGE_LABELS: Record<string, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  json: 'JSON',
  css: 'CSS',
  scss: 'SCSS',
  html: 'HTML',
  markdown: 'Markdown',
  python: 'Python',
  rust: 'Rust',
  go: 'Go',
  shell: 'Shell',
  yaml: 'YAML',
  plaintext: 'Обычный текст',
};

export function languageFromPath(filePath: string): string {
  const name = filePath.slice(filePath.lastIndexOf('/') + 1).toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'makefile';

  const dot = name.lastIndexOf('.');
  if (dot < 0) return 'plaintext';
  return EXTENSION_LANGUAGE[name.slice(dot + 1)] ?? 'plaintext';
}

export function languageLabel(languageId: string): string {
  return LANGUAGE_LABELS[languageId] ?? languageId;
}
