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

// Desktop-control guard: agents build a web app here and must never drive the
// real machine — no computer-use, no switching the real browser's tabs, no
// screen capture, no keystroke injection. Mirrors imp/scripts/desktop-guard.mjs
// (Pi compiles its own TypeScript and cannot import the .mjs, so the rule shape
// is duplicated on purpose). Browser verification is Playwright (`/qa`), never
// the real Chrome; a missing secret is asked for, never scraped.
const DESKTOP_CONTROL: { label: string; test: (c: string) => boolean }[] = [
	{ label: "Orca computer-use (`orca computer …`)", test: (c) => /\borca\s+computer\b/.test(c) },
	{
		label: "desktop input injection (cliclick / xdotool / ydotool / dotool)",
		test: (c) => /\bcliclick\b/.test(c) || /\b(?:xdotool|ydotool|dotool)\b/.test(c),
	},
	{ label: "screen capture (`screencapture`)", test: (c) => /\bscreencapture\b/.test(c) },
	{
		label: "AppleScript UI automation (`osascript` driving System Events)",
		test: (c) => /\bosascript\b/.test(c) && /(system events|keystroke|key code|key down|key up)/i.test(c),
	},
];

function blockedDesktopControl(command: string): string | undefined {
	for (const rule of DESKTOP_CONTROL) {
		if (rule.test(command)) return rule.label;
	}
	return undefined;
}

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

			const desktop = blockedDesktopControl(command);
			if (desktop) {
				if (ctx.hasUI) {
					ctx.ui.notify(`FIA: blocked ${desktop} — agents don't operate the real machine`, "warning");
				}
				return {
					block: true,
					reason:
						`Blocked: ${desktop}. Agents in this project must never drive the real machine — ` +
						"no computer-use, no switching the real browser's tabs, no screen capture, no keystroke injection. " +
						"Verify the UI with Playwright instead (`/qa` runs an isolated dev server on 127.0.0.1, never your real Chrome). " +
						"If you are missing a secret (an R2 S3 token, a dashboard-only key), STOP and ask the engineer to paste it " +
						"(or `npx convex env set <KEY> <value>`) — never obtain it from browser tabs, screenshots, logs, or another app.",
				};
			}

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
