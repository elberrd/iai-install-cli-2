import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

async function read(path) {
  if (!existsSync(path)) return '';
  return readFile(path, 'utf8');
}

function escapeKey(k) {
  return k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripQuotes(v) {
  const t = v.trim();
  // Double-quoted values: also undo the internal escaping upsertEnvVar
  // applies (\" → "), so a value round-trips write → read unchanged.
  if (/^".*"$/.test(t)) return t.slice(1, -1).replace(/\\"/g, '"');
  return t.replace(/^['"]|['"]$/g, '').trim();
}

/** Parse a single KEY's value from an env file (last occurrence wins). */
export async function getEnvVar(path, key) {
  const text = await read(path);
  const re = new RegExp(`^\\s*${escapeKey(key)}\\s*=(.*)$`);
  let value = null;
  for (const line of text.split(/\r?\n/)) {
    const m = re.exec(line);
    if (m) value = stripQuotes(m[1]);
  }
  return value;
}

/** Remove every `KEY=…` line from an env file (no-op if absent). */
export async function removeEnvVar(path, key) {
  const text = await read(path);
  if (!text) return;
  const re = new RegExp(`^\\s*${escapeKey(key)}\\s*=`);
  const kept = text.split(/\r?\n/).filter((line) => !re.test(line));
  await writeFile(path, kept.join('\n'), 'utf8');
}

/**
 * Insert or update `KEY=value` in an env file, preserving comments and other
 * lines. Creates the file if it does not exist. Values with line breaks are
 * rejected (they would inject extra lines into the file); values an env
 * parser could misread (spaces, `#`, `=`) are written between double quotes.
 */
export async function upsertEnvVar(path, key, value) {
  const raw = String(value ?? '');
  if (/[\r\n]/.test(raw)) {
    throw new Error(
      `The value for ${key} contains a line break — env values must be a single line. ` +
        'Remove the line break from the value and run the command again.',
    );
  }
  const needsQuotes = /[\s#=]/.test(raw) && !/^".*"$/.test(raw);
  const rendered = needsQuotes ? `"${raw.replace(/"/g, '\\"')}"` : raw;
  const text = await read(path);
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^\\s*${escapeKey(key)}\\s*=`);
  let replaced = false;
  const next = lines.map((line) => {
    if (re.test(line)) {
      replaced = true;
      return `${key}=${rendered}`;
    }
    return line;
  });
  if (!replaced) {
    if (next.length && next[next.length - 1] === '') next.pop();
    next.push(`${key}=${rendered}`);
    next.push('');
  }
  await writeFile(path, next.join('\n'), 'utf8');
}
