import { existsSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Agent-config paths the harness owns and the "replace" policy may swap out.
 * Also covers what OTHER agent tools leave behind (CLAUDE.md, .cursorrules,
 * .windsurf…): stale instructions there fight the harness's AGENTS.md, so
 * they must at least trigger the up-front policy question.
 * Deliberately NARROW: app code, `ai-docs/` (the project's PRD lives there),
 * `docs/`, `AGENTS.md` (always append-merged) and `.mcp.json` are never
 * touched (`.cursor/mcp.json` DOES move — it lives inside `.cursor`).
 * `HARNESS.md` (root) is the pre-imp legacy location of the guide; current
 * installs keep it at `imp/HARNESS.md`. The FIA runtime itself (`imp/`) is
 * NOT a target — it holds student data (imp/data, imp/fia.config.yaml).
 */
export const AGENT_FILE_TARGETS = [
  '.claude',
  '.cursor',
  '.cursorrules',
  '.agents',
  '.pi',
  '.windsurf',
  '.windsurfrules',
  'CLAUDE.md',
  'HARNESS.md',
  'imp/HARNESS.md',
];

/** Which agent-config paths already exist in the target project. */
export function presentAgentFiles(dir) {
  return AGENT_FILE_TARGETS.filter((rel) => existsSync(join(dir, rel)));
}

/**
 * Move the existing agent files into `.agents-backup-<stamp>/` inside the
 * project. Nothing is ever deleted — "replace" is always reversible by hand.
 * Returns the backup dir path.
 */
export async function backupAgentFiles(dir, present, now = new Date()) {
  const stamp = now.toISOString().slice(0, 19).replaceAll(':', '-').replace('T', '_');
  const backupDir = join(dir, `.agents-backup-${stamp}`);
  await mkdir(backupDir, { recursive: true });
  for (const rel of present) {
    // Nested targets (imp/HARNESS.md) keep their relative path in the backup.
    await mkdir(dirname(join(backupDir, rel)), { recursive: true });
    await rename(join(dir, rel), join(backupDir, rel));
  }
  return backupDir;
}
