/**
 * FDA lock guard — read-only interactive Pi while a FIA run is active.
 *
 * The runner (imp/modules/session.mjs) holds imp/data/.fda.lock for the whole
 * run; its permission gate attributes every tree change to the current phase
 * agent and rolls back what the phase did not declare. An interactive session
 * writing mid-run therefore loses its work or contaminates the run's commit —
 * this extension blocks repo writes while a LIVE lock exists.
 *
 * Pi mirror of .claude/hooks/fda-lock.mjs (Claude sessions get the same guard
 * through hooks). The FDA's own subagents are exempt: the runner exports
 * FIA_FDA_RUN into their environment. Everything fails OPEN — a missing or
 * stale lock (dead pid) never blocks anything.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type FdaLock = { pid?: number; fda_id?: string; runner?: string; started_at?: string };

/** The single-run lock, when a LIVE process (not this one) holds it. */
function activeLock(): FdaLock | undefined {
	if (process.env.FIA_FDA_RUN) return undefined; // inside the run's own process tree
	let lock: FdaLock | undefined;
	try {
		const raw = fs.readFileSync(path.join(process.cwd(), "imp", "data", ".fda.lock"), "utf8");
		lock = JSON.parse(raw) as FdaLock;
	} catch {
		return undefined; /* no lock or unreadable — no active run */
	}
	if (!lock?.pid || lock.pid === process.pid) return undefined;
	try {
		process.kill(lock.pid, 0); // ESRCH when the pid is dead → stale lock
		return lock;
	} catch (err) {
		// EPERM = the pid EXISTS but belongs to another user — the run is
		// alive and the lock must hold; anything else means stale.
		return (err as NodeJS.ErrnoException)?.code === "EPERM" ? lock : undefined;
	}
}

/** Does `raw` resolve to the project root or below it? */
function insideRepo(raw: string): boolean {
	if (!raw) return false;
	const resolved = path.resolve(process.cwd(), raw);
	const rel = path.relative(process.cwd(), resolved).split(path.sep).join("/");
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Bash write-context heuristics — same shape as fia-guard.ts, plus the git
// verbs that move the tree/index/history (a mid-run commit is exactly the
// incident this lock exists to prevent).
const WRITE_BINARY = /(^|[\s;&|(])(rm|mv|cp|tee|chmod|chown|truncate|dd|ln|rsync|install)(\s|$)/;
const SED_IN_PLACE = /(^|[\s;&|(])sed\s+(-\S*i|--in-place)/;
const GIT_WRITE =
	/(^|[\s;&|(])git\s+(add|am|apply|checkout|cherry-pick|clean|commit|merge|mv|rebase|reset|restore|revert|rm|stash|switch)\b/;

/** Targets of >/>> redirections (writes even without a write binary). */
function redirectTargets(command: string): string[] {
	const out: string[] = [];
	const re = />{1,2}\s*([^\s;|&<>]+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(command))) out.push(m[1].replace(/^["']+|["']+$/g, ""));
	return out;
}

/** Would this bash command write inside the repository? */
function bashWritesInRepo(command: string): boolean {
	if (GIT_WRITE.test(command)) return true;
	if (redirectTargets(command).some(insideRepo)) return true;
	if (!WRITE_BINARY.test(command) && !SED_IN_PLACE.test(command)) return false;
	const tokens = command
		.split(/[\s;|&()<>]+/)
		.map((t) => t.replace(/^["']+|["']+$/g, ""))
		.filter(Boolean);
	// Only path-looking tokens count: outside paths (/tmp/…) never block —
	// the run only guards its own tree.
	return tokens.some((t) => /[/.]/.test(t) && insideRepo(t));
}

function reason(lock: FdaLock, target: string): string {
	return (
		`FIA run active (fda_id ${lock.fda_id ?? "unknown"}, pid ${lock.pid ?? "?"}): ${target} touches this repository, ` +
		"and repo writes are blocked while the FDA runs — its permission gate would attribute the change to the " +
		"current phase agent and roll it back. Reading and inspecting are fine. Wait for the run to finish " +
		"(npm run fda:sessions); the lock lifts automatically. If the run is truly gone, remove imp/data/.fda.lock and retry."
	);
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "write" || event.toolName === "edit") {
			const lock = activeLock();
			if (!lock) return undefined;
			const rawPath = String(event.input.path ?? "");
			if (!insideRepo(rawPath)) return undefined;
			if (ctx.hasUI) {
				ctx.ui.notify(`FIA run active — repo write blocked: ${rawPath}`, "warning");
			}
			return { block: true, reason: reason(lock, `"${rawPath}"`) };
		}

		if (event.toolName === "bash") {
			const lock = activeLock();
			if (!lock) return undefined;
			const command = String(event.input.command ?? "");
			if (!bashWritesInRepo(command)) return undefined;
			if (ctx.hasUI) {
				ctx.ui.notify("FIA run active — repo write blocked in bash command", "warning");
			}
			return { block: true, reason: reason(lock, "this command") };
		}

		return undefined;
	});
}
