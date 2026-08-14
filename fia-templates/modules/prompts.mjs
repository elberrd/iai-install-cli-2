import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

export function render(templatePath, variables) {
  let text = readFileSync(templatePath, 'utf8');
  for (const [key, value] of Object.entries(variables)) {
    text = text.replaceAll(`{{${key}}}`, value ?? '');
  }
  return text;
}

export function savePromptDir(directory, name, content) {
  mkdirSync(directory, { recursive: true });
  const path = `${directory}/${name}`;
  writeFileSync(path, content, 'utf8');
  return path;
}
