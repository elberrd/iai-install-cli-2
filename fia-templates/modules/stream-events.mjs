/**
 * Stream recorder — turns the raw engine event streams (Pi --mode json,
 * Claude --output-format stream-json) into rows in the `events` table, so the
 * viewer can show tool calls with real durations while a phase runs.
 *
 * Pi events   : tool_execution_start / tool_execution_end (toolCallId, toolName, args, isError)
 * Claude events: type=assistant → content[].type=tool_use (id, name, input)
 *                type=user      → content[].type=tool_result (tool_use_id, is_error)
 */
import { nowIso } from './utils.mjs';

const PREVIEW_CHARS = 320;

export function preview(value) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : safeJson(value);
  return text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) + '…' : text;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** One-line human summary of a tool call, e.g. `read: src/app.ts` or `bash: npm test`. */
export function toolSummary(toolName, args) {
  if (!args || typeof args !== 'object') return toolName;
  const path = args.path || args.file_path || args.filePath;
  if (path) return `${toolName}: ${path}`;
  if (args.command) return `${toolName}: ${preview(String(args.command)).slice(0, 120)}`;
  if (args.pattern) return `${toolName}: ${args.pattern}`;
  return toolName;
}

export function makeStreamRecorder(run, phase, agent) {
  const open = new Map(); // toolCallId → { name, args, startedAt }

  const record = (name, payload, startedAt, endedAt) => {
    try {
      run.tracer.event({
        fda_id: run.fdaId,
        phase_id: phase.phase_id,
        type: 'tool_call',
        name,
        payload,
        started_at: startedAt,
        ended_at: endedAt,
      });
    } catch {
      /* tracing must never break the run */
    }
  };

  return (event) => {
    if (!event || typeof event !== 'object') return;

    // ── Pi (--mode json) ────────────────────────────────────────────────
    if (event.type === 'tool_execution_start' && event.toolCallId) {
      open.set(event.toolCallId, { name: event.toolName, args: event.args, startedAt: nowIso() });
      return;
    }
    if (event.type === 'tool_execution_end' && event.toolCallId) {
      const started = open.get(event.toolCallId);
      open.delete(event.toolCallId);
      record(
        toolSummary(event.toolName, started?.args),
        {
          agent: agent.name,
          tool: event.toolName,
          args: preview(started?.args),
          ok: !event.isError,
          result: preview(resultText(event.result)),
        },
        started?.startedAt || nowIso(),
        nowIso(),
      );
      return;
    }

    // ── Cursor (agent CLI stream-json) ──────────────────────────────────
    if (event.type === 'tool_call' && (event.subtype === 'started' || event.subtype === 'completed') && event.tool_call) {
      const kind = Object.keys(event.tool_call).find((k) => k.endsWith('ToolCall')) || Object.keys(event.tool_call)[0];
      if (!kind) return;
      const call = event.tool_call[kind] || {};
      const toolName = kind.replace(/ToolCall$/, '');
      const key = 'cursor:' + (event.call_id || event.tool_call_id || toolName);
      if (event.subtype === 'started') {
        open.set(key, { name: toolName, args: call.args, startedAt: nowIso() });
        return;
      }
      const started = open.get(key);
      open.delete(key);
      record(
        toolSummary(toolName, started?.args || call.args),
        {
          agent: agent.name,
          tool: toolName,
          args: preview(started?.args || call.args),
          ok: !call.error,
          result: preview(resultText(call.result)),
        },
        started?.startedAt || nowIso(),
        nowIso(),
      );
      return;
    }

    // ── Claude (stream-json) ────────────────────────────────────────────
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block.type === 'tool_use' && block.id) {
          open.set(block.id, { name: block.name, args: block.input, startedAt: nowIso() });
        }
      }
      return;
    }
    if (event.type === 'user' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block.type === 'tool_result' && block.tool_use_id && open.has(block.tool_use_id)) {
          const started = open.get(block.tool_use_id);
          open.delete(block.tool_use_id);
          record(
            toolSummary(started.name, started.args),
            {
              agent: agent.name,
              tool: started.name,
              args: preview(started.args),
              ok: !block.is_error,
              result: preview(resultText(block.content)),
            },
            started.startedAt,
            nowIso(),
          );
        }
      }
    }
  };
}

function resultText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    return result
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join(' ')
      .trim();
  }
  if (Array.isArray(result.content)) return resultText(result.content);
  if (typeof result.text === 'string') return result.text;
  return safeJson(result);
}
