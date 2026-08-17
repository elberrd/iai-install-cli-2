/**
 * FIA telemetry — records interactive Pi prompt runs (/map, /stack, /idea…)
 * to imp/data/telemetry/ for the TUI and web viewer. Fail-open: telemetry
 * must never block or break a Pi session.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type UsageSlice = {
	tokens_in: number;
	tokens_out: number;
	cache_read: number;
	cache_write: number;
	cost: number;
};

type PhaseRecord = {
	id: string;
	label: string;
	started_at: string;
	ended_at: string | null;
	tokens_in: number;
	tokens_out: number;
	cost: number;
};

type ActiveCommand = {
	id: string;
	command: string;
	args: string;
	session_id: string;
	started_at: string;
	settled_at: string | null;
	tokens_in: number;
	tokens_out: number;
	cache_read: number;
	cache_write: number;
	cost: number;
	docs_written: string[];
	phases: PhaseRecord[];
	current_activity: string | null;
	open_phases: Map<string, PhaseRecord>;
};

const DATA_DIR = path.join("imp", "data");
const TELEMETRY_DIR = path.join(DATA_DIR, "telemetry");
const NDJSON = path.join(TELEMETRY_DIR, "commands.ndjson");
const LIVE = path.join(TELEMETRY_DIR, "live.json");

function enabled(): boolean {
	try {
		return fs.existsSync(path.join(process.cwd(), DATA_DIR));
	} catch {
		return false;
	}
}

function loadPrompts(): Set<string> {
	const out = new Set<string>();
	try {
		const dir = path.join(process.cwd(), ".pi", "prompts");
		for (const name of fs.readdirSync(dir)) {
			if (name.endsWith(".md")) out.add(name.slice(0, -3));
		}
	} catch {
		/* no prompts dir — stay empty */
	}
	return out;
}

function parseCommand(text: string, prompts: Set<string>): { command: string; args: string } | null {
	const m = String(text || "").trim().match(/^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/s);
	if (!m) return null;
	const command = m[1];
	if (!prompts.has(command)) return null;
	return { command, args: (m[2] || "").trim().slice(0, 500) };
}

function extractUsage(message: unknown): UsageSlice | null {
	const u = (message as { usage?: Record<string, unknown> })?.usage;
	if (!u) return null;
	const costObj = u.cost as Record<string, number> | undefined;
	return {
		tokens_in: Number(u.input ?? u.input_tokens ?? 0) || 0,
		tokens_out: Number(u.output ?? u.output_tokens ?? 0) || 0,
		cache_read: Number(u.cacheRead ?? u.cache_read ?? 0) || 0,
		cache_write: Number(u.cacheWrite ?? u.cache_write ?? 0) || 0,
		cost: Number(costObj?.total ?? 0) || 0,
	};
}

function relPath(raw: string): string | null {
	try {
		const rel = path.relative(process.cwd(), path.resolve(process.cwd(), raw)).split(path.sep).join("/");
		if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
		return rel;
	} catch {
		return null;
	}
}

function isAiDoc(rel: string): boolean {
	return rel === "ai-docs" || rel.startsWith("ai-docs/");
}

function summarizeTool(toolName: string, args: unknown): string {
	const a = (args || {}) as Record<string, unknown>;
	if (toolName === "write" || toolName === "edit") {
		const p = relPath(String(a.path ?? ""));
		return p ? `${toolName} ${p}` : toolName;
	}
	if (toolName === "bash") {
		const cmd = String(a.command ?? "").trim().split("\n")[0];
		return cmd ? `bash ${cmd.slice(0, 80)}` : "bash";
	}
	const agent = a.agent ?? a.name ?? a.subagent;
	if (agent) return `${toolName}: ${String(agent)}`;
	const desc = a.description ?? a.prompt ?? a.task;
	if (desc) return `${toolName}: ${String(desc).slice(0, 80)}`;
	return toolName;
}

function ensureDir() {
	fs.mkdirSync(path.join(process.cwd(), TELEMETRY_DIR), { recursive: true });
}

function appendLine(obj: Record<string, unknown>) {
	try {
		ensureDir();
		fs.appendFileSync(path.join(process.cwd(), NDJSON), `${JSON.stringify(obj)}\n`, "utf8");
	} catch {
		/* fail-open */
	}
}

function writeLive(active: ActiveCommand | null) {
	try {
		ensureDir();
		const payload = active
			? {
					id: active.id,
					command: active.command,
					args: active.args,
					session_id: active.session_id,
					started_at: active.started_at,
					settled_at: active.settled_at,
					tokens_in: active.tokens_in,
					tokens_out: active.tokens_out,
					cache_read: active.cache_read,
					cache_write: active.cache_write,
					cost: active.cost,
					docs_written: active.docs_written,
					phases: active.phases,
					current_activity: active.current_activity,
					status: active.settled_at ? "settled" : "running",
				}
			: null;
		fs.writeFileSync(path.join(process.cwd(), LIVE), `${JSON.stringify(payload)}\n`, "utf8");
	} catch {
		/* fail-open */
	}
}

function addUsage(active: ActiveCommand, u: UsageSlice) {
	active.tokens_in += u.tokens_in;
	active.tokens_out += u.tokens_out;
	active.cache_read += u.cache_read;
	active.cache_write += u.cache_write;
	active.cost += u.cost;
}

function finishCommand(active: ActiveCommand, reason: string) {
	const ended_at = new Date().toISOString();
	for (const ph of active.open_phases.values()) {
		if (!ph.ended_at) {
			ph.ended_at = ended_at;
			appendLine({ type: "phase_end", command_id: active.id, phase_id: ph.id, ended_at });
		}
	}
	active.open_phases.clear();
	active.current_activity = null;
	appendLine({
		type: "command_end",
		command_id: active.id,
		command: active.command,
		reason,
		ended_at,
		settled_at: active.settled_at,
		tokens_in: active.tokens_in,
		tokens_out: active.tokens_out,
		cache_read: active.cache_read,
		cache_write: active.cache_write,
		cost: active.cost,
		docs_written: active.docs_written,
		phases: active.phases,
	});
	writeLive(null);
}

export default function (pi: ExtensionAPI) {
	let prompts = new Set<string>();
	let active: ActiveCommand | null = null;
	let sessionId = "";

	const startCommand = (command: string, args: string) => {
		if (active) finishCommand(active, "superseded");
		const id = randomUUID();
		const started_at = new Date().toISOString();
		active = {
			id,
			command,
			args,
			session_id: sessionId,
			started_at,
			settled_at: null,
			tokens_in: 0,
			tokens_out: 0,
			cache_read: 0,
			cache_write: 0,
			cost: 0,
			docs_written: [],
			phases: [],
			current_activity: null,
			open_phases: new Map(),
		};
		appendLine({ type: "command_start", command_id: id, command, args, session_id: sessionId, started_at });
		writeLive(active);
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!enabled()) return;
		prompts = loadPrompts();
		try {
			sessionId = ctx.sessionManager?.getSessionId?.() ?? ctx.sessionManager?.sessionId ?? "";
		} catch {
			sessionId = "";
		}
	});

	pi.on("input", async (event) => {
		if (!enabled()) return;
		const hit = parseCommand(event.text, prompts);
		if (!hit) return;
		startCommand(hit.command, hit.args);
	});

	pi.on("message_end", async (event) => {
		if (!enabled() || !active) return;
		const msg = event.message as { role?: string; usage?: unknown };
		const usage = extractUsage(msg);
		if (usage && (usage.tokens_in || usage.tokens_out || usage.cost)) {
			addUsage(active, usage);
			appendLine({
				type: "usage",
				command_id: active.id,
				at: new Date().toISOString(),
				role: msg.role,
				...usage,
			});
			writeLive(active);
		}
	});

	pi.on("tool_execution_start", async (event) => {
		if (!enabled() || !active) return;
		const label = summarizeTool(event.toolName, event.args);
		active.current_activity = label;
		const phase: PhaseRecord = {
			id: event.toolCallId,
			label,
			started_at: new Date().toISOString(),
			ended_at: null,
			tokens_in: 0,
			tokens_out: 0,
			cost: 0,
		};
		active.open_phases.set(event.toolCallId, phase);
		active.phases.push(phase);
		appendLine({
			type: "phase_start",
			command_id: active.id,
			phase_id: phase.id,
			label,
			started_at: phase.started_at,
		});
		writeLive(active);

		if (event.toolName === "write" || event.toolName === "edit") {
			const p = relPath(String((event.args as { path?: string })?.path ?? ""));
			if (p && isAiDoc(p) && !active.docs_written.includes(p)) {
				active.docs_written.push(p);
				appendLine({ type: "doc_written", command_id: active.id, path: p, at: new Date().toISOString() });
				writeLive(active);
			}
		}
	});

	pi.on("tool_execution_end", async (event) => {
		if (!enabled() || !active) return;
		const phase = active.open_phases.get(event.toolCallId);
		const ended_at = new Date().toISOString();
		if (phase) {
			phase.ended_at = ended_at;
			const nested = extractUsage((event.result as { usage?: unknown }) ?? null);
			if (nested) {
				phase.tokens_in += nested.tokens_in;
				phase.tokens_out += nested.tokens_out;
				phase.cost += nested.cost;
				addUsage(active, nested);
			}
			active.open_phases.delete(event.toolCallId);
			appendLine({
				type: "phase_end",
				command_id: active.id,
				phase_id: phase.id,
				ended_at,
				tokens_in: phase.tokens_in,
				tokens_out: phase.tokens_out,
				cost: phase.cost,
				is_error: Boolean(event.isError),
			});
		}
		active.current_activity = active.open_phases.size
			? [...active.open_phases.values()].slice(-1)[0]?.label ?? null
			: null;
		writeLive(active);
	});

	pi.on("agent_settled", async () => {
		if (!enabled() || !active) return;
		active.settled_at = new Date().toISOString();
		appendLine({ type: "settled", command_id: active.id, settled_at: active.settled_at });
		writeLive(active);
	});

	pi.on("session_shutdown", async () => {
		if (!enabled() || !active) return;
		finishCommand(active, "session_shutdown");
		active = null;
	});
}
