/**
 * FIA guard — blocks agent writes/edits to FIA-protected paths in interactive Pi.
 * Same allowlist as imp/fia.config.yaml → defaults.protected_files. The runner
 * (FDAs) enforces this with git snapshots + rollback; this extension covers the
 * interactive orchestrator and pi-subagents.
 *
 * Based on the official protected-paths example from @earendil-works/pi-coding-agent.
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROTECTED = [/^imp\/modules(\/|$)/, /^imp\/fia\.config\.yaml$/, /^imp\/fda_[^/]+\.mjs$/];
// Substring fallback for paths that resolve outside the project root (absolute
// paths, ../…) — the pattern the official protected-paths.ts example uses.
const PROTECTED_SEGMENTS = ["/imp/modules/", "/imp/fia.config.yaml", "/imp/fda_"];

/** Canonical project-relative form: resolves ./, ../, foo/./bar and absolute paths. */
function toProjectRelative(raw: string): string {
	const resolved = path.resolve(process.cwd(), raw);
	return path.relative(process.cwd(), resolved).split(path.sep).join("/");
}

function isProtected(raw: string): boolean {
	if (!raw) return false;
	const rel = toProjectRelative(raw);
	if (PROTECTED.some((re) => re.test(rel))) return true;
	if (rel.startsWith("..")) {
		// Escapes the project root — fall back to substring matching on the
		// resolved path so '../proj/imp/modules/x.mjs' still gets blocked.
		const resolved = path.resolve(process.cwd(), raw).split(path.sep).join("/");
		return PROTECTED_SEGMENTS.some((seg) => resolved.includes(seg));
	}
	return false;
}

// Bash write-context heuristics: a protected path only blocks the command when
// it appears alongside a binary/operator that mutates files.
const WRITE_BINARY = /(^|[\s;&|(])(rm|mv|cp|tee|chmod|chown|truncate|dd|ln|rsync|install)(\s|$)/;
const SED_IN_PLACE = /(^|[\s;&|(])sed\s+(-\S*i|--in-place)/;

/** First token in the command that resolves to a protected path, if any. */
function firstProtectedToken(command: string): string | undefined {
	const tokens = command
		.split(/[\s;|&()<>]+/)
		.map((t) => t.replace(/^["']+|["']+$/g, ""))
		.filter(Boolean);
	// A write command aimed at the whole `imp/` dir (e.g. `rm -rf imp`) also
	// destroys protected machinery — treat it as protected here.
	return tokens.find((t) => (/[/.]/.test(t) && isProtected(t)) || toProjectRelative(t) === "imp");
}

/** Targets of >/>> redirections (writes even without a write binary). */
function redirectTargets(command: string): string[] {
	const out: string[] = [];
	const re = />{1,2}\s*([^\s;|&<>]+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(command))) out.push(m[1].replace(/^["']+|["']+$/g, ""));
	return out;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "write" || event.toolName === "edit") {
			const rawPath = String(event.input.path ?? "");
			if (isProtected(rawPath)) {
				if (ctx.hasUI) {
					ctx.ui.notify(`FIA: protected path — ${rawPath}`, "warning");
				}
				return {
					block: true,
					reason: `"${rawPath}" is FIA infrastructure (protected). Ask the engineer to change it manually or via impactus.`,
				};
			}
			return undefined;
		}

		if (event.toolName === "bash") {
			const command = String(event.input.command ?? "");
			const writeContext = WRITE_BINARY.test(command) || SED_IN_PLACE.test(command);
			const hit = (writeContext ? firstProtectedToken(command) : undefined) ?? redirectTargets(command).find((t) => isProtected(t));
			if (hit) {
				if (ctx.hasUI) {
					ctx.ui.notify(`FIA: protected path in bash command — ${hit}`, "warning");
				}
				return {
					block: true,
					reason: `This command writes to "${hit}", which is FIA infrastructure (protected). Reading it is fine; to change it, ask the engineer to do it manually or via impactus.`,
				};
			}
			return undefined;
		}

		return undefined;
	});
}
