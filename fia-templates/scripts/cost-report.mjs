const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

const numberOr = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function payloadOf(raw) {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** Validate the optional CLI filter without silently widening an invalid id to all runs. */
export function parseCostReportId(arg) {
  if (arg === undefined) return null;
  if (!SAFE_ID.test(arg)) {
    throw new Error('Usage: node imp/scripts/fia-query.mjs cost-report [fda_id]  (letters, digits, - and _ only)');
  }
  return arg;
}

/**
 * Convert raw trace events into the stable public report shape. Legacy events
 * did not stamp input/output separately: expose those cells as null instead of
 * manufacturing a misleading "fresh input" value from total-output-unknown.
 */
export function costReportRows(rawRows) {
  return rawRows.map((row) => {
    const payload = payloadOf(row.payload_json);
    const hasBreakdown = hasOwn(payload, 'input') && hasOwn(payload, 'output');
    const input = hasBreakdown ? numberOr(payload.input) : null;
    const output = hasBreakdown ? numberOr(payload.output) : null;
    const cacheRead = numberOr(payload.cache_read);
    const cacheWrite = numberOr(payload.cache_write);
    const inputTotal = hasBreakdown ? input + cacheRead + cacheWrite : 0;
    return {
      fda_id: row.fda_id,
      phase: row.phase || row.phase_id || '—',
      agent: row.agent,
      engine: payload.coding_agent || null,
      model: payload.model || null,
      total: numberOr(row.total),
      // Preserve the command's original `fresh` column name; unlike the first
      // implementation it now contains ONLY uncached input, never output.
      fresh: input,
      cache_read: cacheRead,
      cache_write: cacheWrite,
      output,
      cost: numberOr(payload.cost),
      cache_pct: inputTotal > 0 ? Number(((cacheRead * 100) / inputTotal).toFixed(1)) : null,
    };
  });
}
