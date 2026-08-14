/**
 * FIA branding — status line for Pi sessions in IAI projects.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (_event, ctx) => {
    if (!ctx.hasUI) return;
    // setStatus(key, text) — the key identifies this extension's status slot.
    ctx.ui.setStatus('fia', 'FIA · IAI Cursos');
  });
}
