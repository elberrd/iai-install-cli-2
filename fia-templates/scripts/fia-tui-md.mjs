/**
 * Markdown → terminal lines for the FIA TUI, via the same pair Specsfy uses
 * (marked + marked-terminal; marked is pinned to 15 because marked-terminal
 * peers `>=1 <16`). Isolated here so the data layer stays UI-free and tests
 * can exercise rendering without Ink.
 *
 * Always returns an array of printable lines — a parser error degrades to the
 * raw text, never throws.
 */
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

const cache = new Map(); // one Marked instance per width — marked.use is per-instance state

function rendererFor(width) {
  if (!cache.has(width)) {
    const m = new Marked();
    m.use(markedTerminal({ width, reflowText: true, tab: 2 }));
    cache.set(width, m);
  }
  return cache.get(width);
}

/** Render markdown to terminal-styled lines wrapped at `width` columns. */
export function renderMarkdown(text, width = 80) {
  const w = Math.max(40, Math.min(200, Math.floor(width)));
  const src = String(text ?? '');
  try {
    const out = String(rendererFor(w).parse(src));
    return out
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\s+$/, '')
      .split('\n');
  } catch {
    return src.split('\n');
  }
}
