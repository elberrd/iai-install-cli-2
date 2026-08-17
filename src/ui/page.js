// The single self-contained HTML page served by the --ui server. No external
// CDN/fonts: everything is inline so it works fully offline. The page fetches
// the addon catalog from /api/catalog (same origin) and posts the choices to
// /api/command, which returns the assembled `npx impactus …` line.

export function renderPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>IMPACTUS CLI — assemble your install</title>
<style>
  :root {
    --bg: #0b0f14; --panel: #121821; --panel-2: #0e141c; --border: #1e2a38;
    --fg: #e6edf3; --muted: #93a1b0; --accent: #38bdf8; --accent-fg: #04121c;
    --good: #34d399; --warn: #fbbf24; --radius: 12px;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f4f7fb; --panel: #ffffff; --panel-2: #f0f4f9; --border: #d7e0ea;
      --fg: #0f172a; --muted: #55647a; --accent: #0284c7; --accent-fg: #ffffff;
      --good: #059669; --warn: #b45309;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  }
  .wrap { max-width: 920px; margin: 0 auto; padding: 32px 20px 48px; }
  header h1 { margin: 0 0 4px; font-size: 24px; letter-spacing: -0.02em; }
  header p { margin: 0 0 24px; color: var(--muted); }
  .card {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 18px 20px; margin: 0 0 16px;
  }
  .card > h2 { margin: 0 0 2px; font-size: 15px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
  .card > .sub { margin: 0 0 14px; color: var(--muted); font-size: 13px; }
  .row { display: flex; flex-wrap: wrap; gap: 10px; }
  .field { display: flex; flex-direction: column; gap: 6px; flex: 1 1 220px; }
  label.small { font-size: 12px; color: var(--muted); }
  input[type=text] {
    background: var(--panel-2); border: 1px solid var(--border); color: var(--fg);
    border-radius: 8px; padding: 9px 11px; font: inherit; width: 100%;
  }
  input[type=text]:focus { outline: 2px solid var(--accent); outline-offset: 0; border-color: transparent; }
  select {
    background: var(--panel-2); border: 1px solid var(--border); color: var(--fg);
    border-radius: 8px; padding: 9px 11px; font: inherit;
  }
  select:focus { outline: 2px solid var(--accent); outline-offset: 0; border-color: transparent; }
  .modes { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 620px) { .modes { grid-template-columns: 1fr; } }
  .mode {
    cursor: pointer; border: 1.5px solid var(--border); border-radius: var(--radius);
    padding: 14px 16px; background: var(--panel-2); transition: border-color .12s, background .12s;
  }
  .mode:hover { border-color: var(--accent); }
  .mode.active { border-color: var(--accent); background: color-mix(in oklab, var(--accent) 12%, var(--panel-2)); }
  .mode.disabled { opacity: .55; cursor: default; }
  .mode.disabled:hover { border-color: var(--border); }
  .mode h3 { margin: 0 0 4px; font-size: 15px; }
  .mode p { margin: 0; color: var(--muted); font-size: 13px; }
  .opt { display: flex; gap: 10px; align-items: flex-start; padding: 8px 0; border-top: 1px solid var(--border); }
  .opt:first-of-type { border-top: 0; }
  .opt input { margin-top: 3px; width: 16px; height: 16px; accent-color: var(--accent); }
  .opt .txt { display: flex; flex-direction: column; }
  .opt .txt b { font-weight: 600; }
  .opt .txt span { color: var(--muted); font-size: 13px; }
  .pillbar { display: flex; flex-wrap: wrap; gap: 8px; }
  .pill {
    cursor: pointer; border: 1.5px solid var(--border); background: var(--panel-2);
    color: var(--fg); border-radius: 999px; padding: 6px 13px; font-size: 13px;
  }
  .pill.active { border-color: var(--accent); background: color-mix(in oklab, var(--accent) 14%, var(--panel-2)); }
  .toggles { display: flex; flex-wrap: wrap; gap: 18px; }
  .toggle { display: flex; align-items: center; gap: 8px; font-size: 14px; }
  .toggle input { width: 16px; height: 16px; accent-color: var(--accent); }
  #hidden-in-harness .card, .full-only { }
  .cmd {
    display: block; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px;
    padding: 12px 14px; white-space: pre-wrap; word-break: break-word; color: var(--fg);
    margin: 0 0 10px;
  }
  button.copy {
    background: var(--accent); color: var(--accent-fg); border: 0; border-radius: 8px;
    padding: 10px 16px; font: inherit; font-weight: 600; cursor: pointer; white-space: nowrap;
  }
  button.copy:active { transform: translateY(1px); }
  .copied { color: var(--good); font-size: 13px; }
  .dir-row { display: flex; gap: 8px; }
  .dir-row input { flex: 1; }
  .dirmeta { margin: 2px 0 0; font-size: 13px; color: var(--muted); }
  .dirmeta b { color: var(--fg); }
  .dirmeta .warn { color: var(--warn); }
  button.ghost {
    background: var(--panel-2); color: var(--fg); border: 1px solid var(--border);
    border-radius: 8px; padding: 9px 14px; font: inherit; cursor: pointer; white-space: nowrap;
  }
  button.ghost:hover { border-color: var(--accent); }
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex;
    align-items: center; justify-content: center; padding: 20px; z-index: 50;
  }
  .modal {
    background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
    width: 100%; max-width: 560px; max-height: 80vh; display: flex; flex-direction: column;
    box-shadow: 0 20px 60px rgba(0,0,0,0.45);
  }
  .modal-head { padding: 14px 18px; border-bottom: 1px solid var(--border); }
  .modal-head h3 { margin: 0 0 8px; font-size: 15px; }
  .modal-path {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
    color: var(--muted); background: var(--panel-2); border: 1px solid var(--border);
    border-radius: 6px; padding: 6px 9px; overflow-x: auto; white-space: nowrap;
  }
  .modal-list { overflow-y: auto; padding: 6px; flex: 1; }
  .dir-item {
    display: flex; align-items: center; gap: 9px; width: 100%; text-align: left;
    background: transparent; border: 0; color: var(--fg); border-radius: 7px;
    padding: 8px 10px; font: inherit; cursor: pointer;
  }
  .dir-item:hover { background: var(--panel-2); }
  .dir-item .ic { color: var(--muted); }
  .dir-empty { color: var(--muted); padding: 12px 10px; font-size: 13px; }
  .modal-foot { padding: 12px 18px; border-top: 1px solid var(--border); display: flex; gap: 10px; justify-content: flex-end; }
  .modal-foot .grow { margin-right: auto; color: var(--muted); font-size: 12px; align-self: center; }
  .hidden { display: none !important; }
  /* ── Access + execution ── */
  .authbar {
    display: flex; align-items: center; gap: 10px; font-size: 13px;
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px;
    padding: 10px 12px; margin-bottom: 14px;
  }
  .authbar .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
  .authbar.ok .dot { background: var(--good); }
  .authbar.bad .dot { background: #e5534b; }
  .authbar .grow { flex: 1; }
  .devicecode {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 22px;
    letter-spacing: .18em; text-align: center; padding: 14px; margin: 10px 0;
    background: var(--panel-2); border: 1px dashed var(--accent); border-radius: 8px;
  }
  .runfoot { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .runstatus { font-size: 13px; color: var(--muted); }
  .runstatus.ok { color: var(--good); }
  .runstatus.bad { color: #e5534b; }
  button.copy[disabled], button.ghost[disabled] { opacity: .5; cursor: not-allowed; }
  /* ── Integrations & keys ── */
  .pill[disabled] { opacity: .45; cursor: not-allowed; }
  .secnote {
    display: flex; gap: 8px; align-items: flex-start; font-size: 13px; color: var(--muted);
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px;
    padding: 10px 12px; margin: 0 0 4px;
  }
  .svc-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 0 0 4px; }
  .svc-head h3 { margin: 0; font-size: 15px; }
  .autohead { margin: 14px 0 0; color: var(--muted); font-size: 13px; }
  .badge {
    font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
    border-radius: 999px; padding: 3px 9px; border: 1px solid var(--border);
  }
  .badge.auto { color: var(--good); border-color: color-mix(in oklab, var(--good) 45%, var(--border)); }
  .badge.keys { color: var(--accent); border-color: color-mix(in oklab, var(--accent) 45%, var(--border)); }
  .svc-note { margin: 2px 0 10px; color: var(--muted); font-size: 13px; }
  .autoitem { display: flex; gap: 8px; align-items: baseline; padding: 6px 0; border-top: 1px solid var(--border); font-size: 13px; }
  .autoitem:first-child { border-top: 0; }
  .autoitem b { font-weight: 600; font-size: 14px; }
  .autoitem span { color: var(--muted); }
  .pastebox {
    width: 100%; background: var(--panel-2); border: 1px dashed var(--border); color: var(--fg);
    border-radius: 8px; padding: 9px 11px; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    resize: vertical; min-height: 52px; margin: 0 0 10px;
  }
  .pastebox:focus { outline: 2px solid var(--accent); outline-offset: 0; border-color: transparent; }
  .kv { display: flex; flex-direction: column; gap: 4px; padding: 7px 0; border-top: 1px solid var(--border); }
  .kv:first-of-type { border-top: 0; }
  .kv label { font-size: 12px; color: var(--muted); }
  .kv label code { color: var(--fg); font-size: 12px; }
  .kv .kv-row { display: flex; gap: 8px; }
  .kv input {
    flex: 1; background: var(--panel-2); border: 1px solid var(--border); color: var(--fg);
    border-radius: 8px; padding: 8px 10px; font: 13px ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .kv input:focus { outline: 2px solid var(--accent); outline-offset: 0; border-color: transparent; }
  .kv input.bad { outline: 2px solid #ef4444; }
  .kv .err { color: #ef4444; font-size: 12px; }
  .kv .autoline { color: var(--muted); font-size: 13px; }
  .kv button.mini {
    background: var(--panel-2); color: var(--fg); border: 1px solid var(--border);
    border-radius: 8px; padding: 0 10px; font: 12px inherit; cursor: pointer; white-space: nowrap;
  }
  .kv button.mini:hover { border-color: var(--accent); }
  .keysaved { color: var(--good); font-size: 12px; }
  /* ── System type (template cards) ── */
  .mode h3 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .badge.tech { color: var(--accent); border-color: color-mix(in oklab, var(--accent) 45%, var(--border)); }
  /* ── "Key with AI" step-by-step ── */
  .aistep { display: flex; gap: 10px; align-items: center; margin: 0 0 9px; font-size: 13px; color: var(--muted); }
  .aistep b { color: var(--fg); }
  .stepnum {
    flex: none; width: 21px; height: 21px; border-radius: 50%; font-size: 12px; font-weight: 700;
    display: flex; align-items: center; justify-content: center; color: var(--accent);
    background: color-mix(in oklab, var(--accent) 16%, var(--panel-2));
    border: 1px solid color-mix(in oklab, var(--accent) 45%, var(--border));
  }
  .paste-ok { color: var(--good); font-size: 12px; margin: -4px 0 10px; }
  /* ── Manual path (collapsed) ── */
  details.manual { border-top: 1px solid var(--border); margin-top: 6px; padding-top: 9px; }
  details.manual summary { cursor: pointer; color: var(--muted); font-size: 13px; list-style-position: inside; }
  details.manual summary:hover { color: var(--accent); }
  details.manual[open] summary { margin-bottom: 8px; }
  .svc-note a { color: var(--accent); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>IMPACTUS CLI</h1>
    <p>Assemble the install by clicking — at the end, copy the command and run it in your terminal.</p>
  </header>

  <section class="card">
    <h2>Project</h2>
    <p class="sub">The project is installed in this folder and inherits its name — I prefilled it with the folder where you ran the command.</p>
    <div class="field">
      <label class="small" for="dir">Project folder</label>
      <div class="dir-row">
        <input type="text" id="dir" placeholder="/path/to/folder" />
        <button type="button" class="ghost" id="browseBtn">Choose…</button>
      </div>
      <p class="dirmeta" id="dirMeta"></p>
    </div>
  </section>

  <section class="card">
    <h2>What to install</h2>
    <p class="sub">The harness (agent workflow) is always installed. The template is optional.</p>
    <div class="modes">
      <div class="mode" data-mode="full">
        <h3>Harness + template</h3>
        <p>Next.js + Convex + Clerk starter and the full stack.</p>
      </div>
      <div class="mode" data-mode="harness">
        <h3>Harness only</h3>
        <p>The agent workflow with YOUR stack — choose layer by layer or decide later by talking with Pi.</p>
      </div>
    </div>
  </section>

  <div id="harness-section" class="hidden">
    <section class="card">
      <h2>Your stack</h2>
      <p class="sub">
        IAI's preferred stack is Next.js + Convex + Clerk + R2 (the ready-made template
        on the other card ships it assembled). Here you build your own stack — any layer
        can stay <b>"decide later"</b>: Pi (<code>/idea</code>) extracts the best
        stack by talking with you, and the system generates the documentation and installs
        the tools (CLI, MCP, skills) for whatever gets chosen.
      </p>
      <div class="pillbar" id="stackPath">
        <button class="pill active" data-stackpath="discover">Decide by talking with Pi</button>
        <button class="pill" data-stackpath="custom">Choose now, layer by layer</button>
      </div>
      <div id="stack-fields" class="hidden" style="margin-top:14px"></div>
    </section>
  </div>

  <div id="full-section">
    <section class="card">
      <h2>System type</h2>
      <p class="sub">What kind of project do you want to create? Both already come with login, database, and a user admin panel ready to go.</p>
      <div class="modes" id="templates"></div>
    </section>

    <section class="card">
      <h2>Stack preset</h2>
      <p class="sub">A starting point — then fine-tune group by group below.</p>
      <div class="pillbar" id="presets"></div>
    </section>

    <div id="groups"></div>

    <section class="card">
      <h2>Services</h2>
      <div class="field" style="max-width:260px">
        <label class="small">File storage</label>
        <div class="pillbar" id="storage">
          <button class="pill active" data-storage="convex">Convex Storage</button>
          <button class="pill" data-storage="r2">Cloudflare R2</button>
        </div>
      </div>
      <div class="toggles" style="margin-top:16px">
        <label class="toggle"><input type="checkbox" id="push" /> Create GitHub repo and push</label>
        <label class="toggle"><input type="checkbox" id="privateRepo" checked /> Private repo</label>
        <label class="toggle"><input type="checkbox" id="deploy" /> Deploy to Vercel</label>
      </div>
    </section>

    <section class="card">
      <h2>Service keys (optional — you can skip)</h2>
      <p class="sub">
        Some services chosen above need a <b>key</b>: a code that links
        your account on the service to your app. <b>You can skip all of this</b> —
        the app works without the keys, and you can enable each service later, at your own pace.
      </p>
      <div class="secnote">🔒
        <span>Your keys stay <b>on this machine only</b>: they are saved to
        <code>~/.impactus-cli/keys/&lt;project&gt;.env</code> (permissions restricted to your
        user) and read by the local installer. They never appear in the command
        and never leave your computer.</span>
      </div>
      <p class="autohead">These the installer configures on its own — nothing to do:</p>
      <div id="svc-auto"></div>
    </section>
    <div id="svc-cards"></div>
  </div>

  <section class="card">
    <h2>Mode</h2>
    <label class="toggle"><input type="checkbox" id="yes" /> Ask nothing (use safe defaults — <code>--yes</code>)</label>
  </section>

  <div class="card" id="runCard">
    <h2>Run the installation</h2>
    <p class="sub">The installation happens in your computer's terminal — just 3 steps.</p>

    <div class="authbar" id="authbar">
      <span class="dot"></span>
      <span class="grow" id="authText">Checking your access…</span>
      <button type="button" class="ghost hidden" id="loginBtn">Sign in</button>
    </div>

    <div class="hidden" id="devicePanel">
      <p class="sub">Open the link, check that the code matches, and authorize:</p>
      <div class="devicecode" id="deviceCode">····</div>
      <a class="ghost" id="deviceLink" target="_blank" rel="noopener">Open the authorization page</a>
    </div>

    <div class="aistep"><span class="stepnum">1</span><span><b>Copy the command</b> — assembled with everything you chose above (a few confirmations, like logins and keys, still happen in the terminal):</span></div>
    <code class="cmd" id="cmd">npx impactus</code>
    <div class="runfoot">
      <button class="copy" id="copyBtn">Copy command</button>
      <span class="copied hidden" id="copied">copied ✓</span>
    </div>

    <div class="aistep" style="margin-top:16px"><span class="stepnum">2</span><span><b>Open your computer's terminal</b>:</span></div>
    <div class="runfoot">
      <button type="button" class="ghost" id="termBtn">Open the terminal for me</button>
      <span class="runstatus" id="termStatus"></span>
    </div>
    <p class="svc-note" style="margin:8px 0 0">If you'd rather open it yourself: on Mac it's the <b>Terminal</b> app; on Windows, the <b>Command Prompt</b>; on Linux, your distribution's terminal.</p>

    <div class="aistep" style="margin-top:14px"><span class="stepnum">3</span><span><b>Paste the command</b> into the terminal (Cmd+V or Ctrl+V) and press <b>Enter</b>. The installation talks with you there all the way to the end.</span></div>
  </div>
</div>

<div class="modal-backdrop hidden" id="picker">
  <div class="modal">
    <div class="modal-head">
      <h3>Choose folder</h3>
      <div class="modal-path" id="pickerPath">/</div>
    </div>
    <div class="modal-list" id="pickerList"></div>
    <div class="modal-foot">
      <span class="grow" id="pickerHint">Navigate and click "Use this folder".</span>
      <button type="button" class="ghost" id="pickerCancel">Cancel</button>
      <button type="button" class="copy" id="pickerUse">Use this folder</button>
    </div>
  </div>
</div>

<script>
const state = {
  mode: 'full', dir: '', preset: '', groups: {},
  storage: 'convex', push: false, privateRepo: true, deploy: false, yes: false,
  keyVals: {}, keysPath: null, templateId: 'live1',
  // "Harness only" path: 'discover' = everything pending (decide with Pi);
  // 'custom' = layer by layer (whatever stays 'depois' is omitted from --stack).
  stackPath: 'discover', stackChoices: {},
};
let catalog = null;

async function boot() {
  catalog = await (await fetch('/api/catalog')).json();
  // The folder comes prefilled with the directory where the command was run —
  // the project NAME is that folder's name (there is no name field).
  state.dir = catalog.cwd || '';
  document.getElementById('dir').value = state.dir;
  renderPresets();
  renderGroups();
  renderTemplates();
  renderServices();
  applyPreset('padrao');
  wireStatic();
  setMode('full');
  updateDirMeta();
  refresh();
}

// Project name = last segment of the chosen folder.
function projectName() {
  let d = (state.dir || '').trim();
  if (!d || d === '.' || d === './') return (catalog && catalog.cwdName) || 'my-app';
  d = d.replace(/[\\\\/]+$/, '');
  const parts = d.split(/[\\\\/]/);
  return parts[parts.length - 1] || 'my-app';
}

function renderPresets() {
  const el = document.getElementById('presets');
  el.innerHTML = '';
  for (const p of catalog.presets) {
    const b = document.createElement('button');
    b.className = 'pill';
    b.dataset.preset = p.value;
    b.textContent = p.label;
    b.title = p.hint || '';
    b.onclick = () => applyPreset(p.value);
    el.appendChild(b);
  }
}

function applyPreset(value) {
  state.preset = value;
  const chosen = new Set(catalog.presetAddons[value] || []);
  // Reset every group from the preset's addon set.
  state.groups = {};
  for (const g of catalog.groups) {
    if (g.single) {
      const pick = g.options.find(o => o.value !== 'none' && chosen.has(o.value));
      state.groups[g.flag] = pick ? pick.value : 'none';
    } else {
      state.groups[g.flag] = g.options.map(o => o.value).filter(v => chosen.has(v));
    }
  }
  syncPresetPills();
  syncGroupInputs();
  scheduleSaveKeys();
  refresh();
}

function syncPresetPills() {
  document.querySelectorAll('#presets .pill').forEach(b =>
    b.classList.toggle('active', b.dataset.preset === state.preset));
}

function renderGroups() {
  const root = document.getElementById('groups');
  root.innerHTML = '';
  for (const g of catalog.groups) {
    const card = document.createElement('section');
    card.className = 'card';
    const h = document.createElement('h2');
    h.textContent = g.title;
    card.appendChild(h);
    if (g.single) {
      const bar = document.createElement('div');
      bar.className = 'pillbar';
      for (const o of g.options) {
        const b = document.createElement('button');
        b.className = 'pill';
        b.dataset.group = g.flag; b.dataset.value = o.value;
        b.textContent = o.label + (o.hint ? '' : '');
        b.title = o.hint || '';
        b.onclick = () => { state.groups[g.flag] = o.value; syncGroupInputs(); markDirty(); };
        bar.appendChild(b);
      }
      card.appendChild(bar);
    } else {
      for (const o of g.options) {
        const opt = document.createElement('label');
        opt.className = 'opt';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.group = g.flag; cb.dataset.value = o.value;
        cb.onchange = () => {
          const arr = state.groups[g.flag] || [];
          const set = new Set(arr);
          cb.checked ? set.add(o.value) : set.delete(o.value);
          state.groups[g.flag] = [...set];
          markDirty();
        };
        const txt = document.createElement('div');
        txt.className = 'txt';
        txt.innerHTML = '<b></b><span></span>';
        txt.querySelector('b').textContent = o.label;
        txt.querySelector('span').textContent = o.hint || '';
        opt.appendChild(cb); opt.appendChild(txt);
        card.appendChild(opt);
      }
    }
    root.appendChild(card);
  }
}

function syncGroupInputs() {
  for (const g of catalog.groups) {
    const sel = state.groups[g.flag];
    if (g.single) {
      document.querySelectorAll('.pill[data-group="' + g.flag + '"]').forEach(b =>
        b.classList.toggle('active', b.dataset.value === (sel || 'none')));
    } else {
      const set = new Set(sel || []);
      document.querySelectorAll('input[data-group="' + g.flag + '"]').forEach(cb =>
        cb.checked = set.has(cb.dataset.value));
    }
  }
}

// A manual group edit means we're no longer on a clean preset.
function markDirty() { state.preset = ''; syncPresetPills(); scheduleSaveKeys(); refresh(); }

function wireStatic() {
  // Only the "What to install" cards ([data-mode]) — the template cards
  // ([data-template]) get their own onclick in renderTemplates.
  document.querySelectorAll('.mode[data-mode]').forEach(m => m.onclick = () => setMode(m.dataset.mode));
  document.querySelectorAll('#stackPath .pill').forEach(b => b.onclick = () => setStackPath(b.dataset.stackpath));
  document.querySelectorAll('#storage .pill').forEach(b => b.onclick = () => {
    state.storage = b.dataset.storage;
    document.querySelectorAll('#storage .pill').forEach(x => x.classList.toggle('active', x === b));
    scheduleSaveKeys();
    refresh();
  });
  const bind = (id, key) => {
    const el = document.getElementById(id);
    const ev = el.type === 'checkbox' ? 'change' : 'input';
    el.addEventListener(ev, () => { state[key] = el.type === 'checkbox' ? el.checked : el.value; refresh(); });
  };
  bind('dir', 'dir');
  bind('push', 'push'); bind('privateRepo', 'privateRepo'); bind('deploy', 'deploy'); bind('yes', 'yes');
  // The folder defines the project name — and with it the keys file
  // (~/.impactus-cli/keys/<slug>.env) and the "folder not empty" warning.
  document.getElementById('dir').addEventListener('input', () => { scheduleSaveKeys(); scheduleDirMeta(); });
  document.getElementById('copyBtn').onclick = copy;
  wirePicker();
}

// ── Derived name + full-folder warning (debounced) ───────────────────────────
let dirMetaTimer = null;
let dirMetaSeq = 0;

function scheduleDirMeta() {
  clearTimeout(dirMetaTimer);
  dirMetaTimer = setTimeout(updateDirMeta, 300);
}

async function updateDirMeta() {
  const meta = document.getElementById('dirMeta');
  const seq = ++dirMetaSeq;
  const d = (state.dir || '').trim();
  if (!d) {
    meta.textContent = 'No folder: the installer creates ./my-app (project "my-app").';
    return;
  }
  let warnText = '';
  try {
    const r = await fetch('/api/dir-info?path=' + encodeURIComponent(d));
    const info = await r.json();
    if (info.exists && !info.empty) {
      warnText = ' — heads up: the folder already has files; prefer an empty or new folder.';
    }
  } catch { /* server busy — show just the name */ }
  if (seq !== dirMetaSeq) return; // late response from an older edit
  meta.textContent = '';
  meta.append('Project name: ');
  const b = document.createElement('b');
  b.textContent = projectName();
  meta.appendChild(b);
  if (warnText) {
    const w = document.createElement('span');
    w.className = 'warn';
    w.textContent = warnText;
    meta.appendChild(w);
  }
}

// ── Integrations & keys ──────────────────────────────────────────────────────
// One card per service: copyable AI prompt + fields to paste the keys.
// Typed keys go (debounced) to POST /api/keys, which writes a LOCAL file
// (~/.impactus-cli/keys/<slug>.env, permission 600); the generated command
// only references the path via --keys.

function chosenAddonIds() {
  const ids = new Set();
  for (const g of catalog.groups) {
    const sel = state.groups[g.flag];
    if (Array.isArray(sel)) sel.forEach(v => ids.add(v));
    else if (sel && sel !== 'none') ids.add(sel);
  }
  return ids;
}

function serviceRelevant(svc) {
  if (svc.when.always) return true;
  if (svc.when.addon) return chosenAddonIds().has(svc.when.addon);
  if (svc.when.storage) return state.storage === svc.when.storage;
  return false;
}

// "System type" cards: friendly name + badge with the technical term
// (single/multi-tenant) + plain-language description. Same look as the mode cards.
function renderTemplates() {
  const el = document.getElementById('templates');
  el.innerHTML = '';
  for (const t of catalog.templates || []) {
    const d = document.createElement('div');
    d.className = 'mode' + (t.available ? '' : ' disabled') +
      (t.value === (state.templateId || 'live1') ? ' active' : '');
    d.dataset.template = t.value;
    const h = document.createElement('h3');
    h.append(t.label + (t.available ? '' : ' — coming soon'));
    if (t.badge) {
      const b = document.createElement('span');
      b.className = 'badge tech';
      b.textContent = t.badge;
      h.appendChild(b);
    }
    const p = document.createElement('p');
    p.textContent = t.description || t.hint || '';
    d.appendChild(h);
    d.appendChild(p);
    if (t.available) {
      d.onclick = () => {
        state.templateId = t.value;
        document.querySelectorAll('#templates .mode').forEach(x =>
          x.classList.toggle('active', x.dataset.template === t.value));
        refresh();
      };
    }
    el.appendChild(d);
  }
}

function renderServices() {
  const autoRoot = document.getElementById('svc-auto');
  const cardsRoot = document.getElementById('svc-cards');
  autoRoot.innerHTML = '';
  cardsRoot.innerHTML = '';
  for (const svc of catalog.services || []) {
    if (svc.setup === 'auto') {
      const item = document.createElement('div');
      item.className = 'autoitem';
      item.dataset.svc = svc.id;
      item.innerHTML = '<b></b><span></span>';
      item.querySelector('b').textContent = '✅ ' + svc.label;
      item.querySelector('span').textContent = svc.autoNote;
      autoRoot.appendChild(item);
    } else {
      cardsRoot.appendChild(buildServiceCard(svc));
    }
  }
  syncServices();
}

// Service card, designed for non-technical folks:
//   • title + "what it's for" in plain language;
//   • live status ("you can skip" → "✓ key filled in");
//   • main path: 3 steps with AI (copy instructions → paste into the AI that
//     controls the browser → paste the reply back);
//   • manual path (technical fields) collapsed in a <details>.
function buildServiceCard(svc) {
  const card = document.createElement('section');
  card.className = 'card';
  card.dataset.svc = svc.id;

  const head = document.createElement('div');
  head.className = 'svc-head';
  const h = document.createElement('h3');
  h.textContent = svc.label;
  const badge = document.createElement('span');
  badge.className = 'badge keys';
  badge.dataset.role = 'status';
  badge.textContent = 'optional — you can skip';
  head.appendChild(h);
  head.appendChild(badge);
  card.appendChild(head);

  if (svc.purpose) {
    const p = document.createElement('p');
    p.className = 'svc-note';
    p.textContent = svc.purpose;
    card.appendChild(p);
  }
  if (svc.setup === 'partial' && svc.autoNote) {
    const p = document.createElement('p');
    p.className = 'svc-note';
    p.textContent = '⚙️ ' + svc.autoNote;
    card.appendChild(p);
  }
  if (svc.keyNote) {
    const p = document.createElement('p');
    p.className = 'svc-note';
    p.textContent = '⚠️ ' + svc.keyNote;
    card.appendChild(p);
  }

  if (svc.promptTemplate) {
    const step1 = document.createElement('div');
    step1.className = 'aistep';
    const n1 = document.createElement('span');
    n1.className = 'stepnum';
    n1.textContent = '1';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost';
    btn.textContent = 'Copy instructions for the AI';
    const ok = document.createElement('span');
    ok.className = 'keysaved hidden';
    ok.textContent = 'copied ✓';
    btn.onclick = () => {
      const text = svc.promptTemplate.split('{{PROJECT}}').join(projectName());
      if (navigator.clipboard) navigator.clipboard.writeText(text);
      ok.classList.remove('hidden');
      setTimeout(() => ok.classList.add('hidden'), 1600);
    };
    step1.appendChild(n1);
    step1.appendChild(btn);
    step1.appendChild(ok);
    card.appendChild(step1);

    const step2 = document.createElement('div');
    step2.className = 'aistep';
    step2.innerHTML = '<span class="stepnum">2</span><span>Paste it into an AI that controls your browser ' +
      '(e.g. <b>Claude in Chrome</b>). It goes to the service site, gets the key for you, ' +
      'and returns a text at the end.</span>';
    card.appendChild(step2);

    const step3 = document.createElement('div');
    step3.className = 'aistep';
    step3.innerHTML = '<span class="stepnum">3</span><span>Paste the AI reply down here:</span>';
    card.appendChild(step3);

    const paste = document.createElement('textarea');
    paste.className = 'pastebox';
    paste.placeholder = 'Paste the AI reply here — I fill everything in for you.';
    const pasteOk = document.createElement('div');
    pasteOk.className = 'paste-ok hidden';
    // Debounced: wait for the typing/paste to settle before consuming — otherwise
    // a half-typed line (e.g. "KEY=h") would be captured too early.
    let pasteTimer = null;
    paste.addEventListener('input', () => {
      clearTimeout(pasteTimer);
      pasteTimer = setTimeout(() => {
        const found = parseKeysText(paste.value, svc);
        const count = Object.keys(found).length;
        if (count === 0) return;
        for (const k of Object.keys(found)) setKeyField(svc, k, found[k]);
        paste.value = '';
        pasteOk.textContent = '✓ Got ' + count + ' key(s) — fields filled in. If any is missing, paste again.';
        pasteOk.classList.remove('hidden');
      }, 400);
    });
    card.appendChild(paste);
    card.appendChild(pasteOk);
  }

  const manual = document.createElement('details');
  manual.className = 'manual';
  const summary = document.createElement('summary');
  summary.textContent = svc.promptTemplate
    ? 'I prefer to get the key myself (no AI)'
    : 'Fill in the keys';
  manual.appendChild(summary);

  if (svc.dashboardUrl) {
    const how = document.createElement('p');
    how.className = 'svc-note';
    how.append('Open ');
    const a = document.createElement('a');
    a.href = svc.dashboardUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = svc.dashboardUrl.replace(/^https?:\\/\\//, '');
    how.appendChild(a);
    how.append(', follow the hint on each field and paste the values:');
    manual.appendChild(how);
  }

  for (const env of svc.envs) {
    if (env.source === 'auto') {
      const kv = document.createElement('div');
      kv.className = 'kv';
      const line = document.createElement('div');
      line.className = 'autoline';
      line.textContent = '⚙️ ' + env.key + ' — ' + (env.autoHint || 'automatic during install');
      kv.appendChild(line);
      manual.appendChild(kv);
      continue;
    }
    manual.appendChild(buildKeyField(svc, env));
  }
  card.appendChild(manual);
  return card;
}

// Has any dashboard key of this service been typed with a valid format?
function svcFilled(svc) {
  return svc.envs.some(e => {
    if (e.source !== 'dashboard') return false;
    const v = (state.keyVals[e.key] || '').trim();
    if (!v || v === (e.default || '')) return false;
    return !e.pattern || new RegExp(e.pattern).test(v);
  });
}

function updateSvcBadge(svcId) {
  const svc = (catalog.services || []).find(s => s.id === svcId);
  const badge = document.querySelector('.card[data-svc="' + svcId + '"] .badge[data-role="status"]');
  if (!svc || !badge) return;
  const done = svcFilled(svc);
  badge.className = 'badge ' + (done ? 'auto' : 'keys');
  badge.textContent = done ? '✓ key filled in' : 'optional — you can skip';
}

function buildKeyField(svc, env) {
  const kv = document.createElement('div');
  kv.className = 'kv';
  const label = document.createElement('label');
  label.innerHTML = '<span></span> · <code></code>';
  label.querySelector('span').textContent = env.label + (env.hint ? ' — ' + env.hint : '');
  label.querySelector('code').textContent = env.key;
  kv.appendChild(label);

  const row = document.createElement('div');
  row.className = 'kv-row';
  const input = document.createElement('input');
  input.type = env.secret ? 'password' : 'text';
  input.placeholder = env.patternHint || '';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.dataset.envKey = env.key;
  input.dataset.svc = svc.id;
  if (env.source === 'generate') input.value = genToken();
  else if (env.default) input.value = env.default;
  state.keyVals[env.key] = input.value.trim();
  row.appendChild(input);

  const err = document.createElement('span');
  err.className = 'err hidden';

  if (env.secret) {
    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'mini';
    eye.textContent = '👁';
    eye.title = 'show/hide';
    eye.onclick = () => { input.type = input.type === 'password' ? 'text' : 'password'; };
    row.appendChild(eye);
  }
  if (env.source === 'generate') {
    const regen = document.createElement('button');
    regen.type = 'button';
    regen.className = 'mini';
    regen.textContent = '↻ generate';
    regen.onclick = () => { input.value = genToken(); onKeyInput(env, input, err); };
    row.appendChild(regen);
  }
  kv.appendChild(row);
  kv.appendChild(err);
  input.addEventListener('input', () => onKeyInput(env, input, err));
  return kv;
}

function onKeyInput(env, input, err) {
  const v = input.value.trim();
  state.keyVals[env.key] = v;
  const bad = v && env.pattern && !(new RegExp(env.pattern).test(v));
  input.classList.toggle('bad', !!bad);
  err.classList.toggle('hidden', !bad);
  if (bad) err.textContent = 'expected format: ' + (env.patternHint || env.pattern);
  updateSvcBadge(input.dataset.svc);
  scheduleSaveKeys();
}

function setKeyField(svc, key, value) {
  const input = document.querySelector('input[data-svc="' + svc.id + '"][data-env-key="' + key + '"]');
  if (!input) return;
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

// Agent reply: KEY=value lines (or KEY: value); ignores comments,
// code fences, quotes, and unfilled <…> placeholders.
function parseKeysText(text, svc) {
  const allowed = new Set(svc.envs.filter(e => e.source !== 'auto').map(e => e.key));
  const found = {};
  for (const raw of String(text || '').split(/\\r?\\n/)) {
    const line = raw.trim().replace(/^[-*•]\\s*/, '');
    if (!line || line.startsWith('#') || line.startsWith('\`\`\`')) continue;
    const m = /^([A-Z][A-Z0-9_]*)\\s*[=:]\\s*(.+)$/.exec(line);
    if (!m || !allowed.has(m[1])) continue;
    const value = m[2].trim().replace(/^[\`'"]+|[\`'",]+$/g, '').trim();
    if (!value || /^<.*>$/.test(value)) continue;
    found[m[1]] = value;
  }
  return found;
}

function genToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
}

// Only keys of RELEVANT services that already have at least one dashboard
// key TYPED go into the file (a value equal to the factory default —
// e.g. the PostHog host — does not count; self-generated tokens do not either).
function collectKeys() {
  const out = {};
  for (const svc of catalog.services || []) {
    if (svc.setup === 'auto' || !serviceRelevant(svc)) continue;
    const dash = svc.envs.filter(e => e.source === 'dashboard');
    const typed = dash.some(e => {
      const v = (state.keyVals[e.key] || '').trim();
      return v && v !== (e.default || '');
    });
    if (!typed) continue;
    for (const env of svc.envs) {
      if (env.source === 'auto') continue;
      const v = (state.keyVals[env.key] || '').trim();
      if (v) out[env.key] = v;
    }
  }
  return out;
}

let keysTimer = null;
let hadKeys = false;        // has any key existed this session? (otherwise never
                            // POST empty — protects the file from a previous session)
let lastSavedName = null;   // to delete the old slug's file when the folder changes

function scheduleSaveKeys() {
  clearTimeout(keysTimer);
  keysTimer = setTimeout(saveKeys, 500);
}

// Ensures any pending edit was persisted (used by Copy).
async function flushKeys() {
  if (keysTimer) { clearTimeout(keysTimer); keysTimer = null; }
  await saveKeys();
}

async function saveKeys() {
  if (!catalog) return;
  const keys = collectKeys();
  const count = Object.keys(keys).length;
  if (!hadKeys && count === 0) return; // nothing to save and nothing to clear
  hadKeys = hadKeys || count > 0;
  const name = projectName();
  try {
    const r = await fetch('/api/keys', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        prevName: lastSavedName && lastSavedName !== name ? lastSavedName : undefined,
        keys,
      }),
    });
    const data = await r.json();
    lastSavedName = name;
    const path = data.path || null;
    if (path !== state.keysPath) { state.keysPath = path; refresh(); }
  } catch (e) {
    // Local server unavailable — retry in 2s (otherwise the last edit
    // would go unpersisted and --keys would come out stale).
    keysTimer = setTimeout(saveKeys, 2000);
  }
}

function syncServices() {
  if (!catalog) return;
  document.querySelectorAll('#svc-cards .card, #svc-auto .autoitem').forEach(el => {
    const svc = (catalog.services || []).find(s => s.id === el.dataset.svc);
    el.classList.toggle('hidden', !svc || !serviceRelevant(svc));
  });
}

// ── Folder picker ────────────────────────────────────────────────────────────
// "Choose…" opens the system's NATIVE dialog (Finder/Explorer/zenity) via
// POST /api/pick-folder — the browser doesn't expose absolute paths, so the
// local server is what opens the dialog. If the platform has no dialog
// (e.g. Linux without zenity/kdialog), fall back to our own modal picker (/api/browse).
let pickerCwd = null;

function wirePicker() {
  document.getElementById('browseBtn').onclick = chooseFolder;
  document.getElementById('pickerCancel').onclick = closePicker;
  document.getElementById('pickerUse').onclick = usePicked;
  const backdrop = document.getElementById('picker');
  backdrop.onclick = (e) => { if (e.target === backdrop) closePicker(); };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !backdrop.classList.contains('hidden')) closePicker();
  });
}

function setDir(path) {
  document.getElementById('dir').value = path;
  state.dir = path;
  scheduleSaveKeys();
  scheduleDirMeta();
  refresh();
}

async function chooseFolder() {
  const btn = document.getElementById('browseBtn');
  btn.disabled = true;
  btn.textContent = 'Opening…';
  try {
    const r = await fetch('/api/pick-folder', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ start: state.dir }),
    });
    const data = await r.json();
    if (data.path) setDir(data.path);
    else if (data.unsupported) openPicker(state.dir);
    // cancelled/busy → nothing to do
  } catch {
    openPicker(state.dir);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Choose…';
  }
}

function openPicker(startPath) {
  document.getElementById('picker').classList.remove('hidden');
  loadDir(startPath && startPath.trim() ? startPath : undefined);
}
function closePicker() {
  document.getElementById('picker').classList.add('hidden');
}

async function loadDir(path) {
  const list = document.getElementById('pickerList');
  list.innerHTML = '<div class="dir-empty">Loading…</div>';
  const qs = path ? '?path=' + encodeURIComponent(path) : '';
  let data;
  try {
    const r = await fetch('/api/browse' + qs);
    data = await r.json();
    if (data.error) throw new Error(data.message || data.error);
  } catch (err) {
    list.innerHTML = '<div class="dir-empty">Could not open: ' + (err.message || err) + '</div>';
    return;
  }
  pickerCwd = data.path;
  document.getElementById('pickerPath').textContent = data.path;
  list.innerHTML = '';

  if (data.parent) {
    list.appendChild(dirButton('⬆︎', '.. (go up)', data.parent));
  }
  if (data.entries.length === 0 && !data.parent) {
    list.appendChild(el('div', 'dir-empty', 'No visible subfolders.'));
  }
  for (const entry of data.entries) {
    list.appendChild(dirButton('📁', entry.name, entry.path));
  }
}

function dirButton(icon, label, path) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'dir-item';
  b.innerHTML = '<span class="ic"></span><span class="nm"></span>';
  b.querySelector('.ic').textContent = icon;
  b.querySelector('.nm').textContent = label;
  b.onclick = () => loadDir(path);
  return b;
}
function el(tag, cls, text) {
  const n = document.createElement(tag);
  n.className = cls; n.textContent = text;
  return n;
}

function usePicked() {
  if (!pickerCwd) return;
  setDir(pickerCwd);
  closePicker();
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.mode[data-mode]').forEach(m => m.classList.toggle('active', m.dataset.mode === mode));
  document.getElementById('full-section').classList.toggle('hidden', mode !== 'full');
  document.getElementById('harness-section').classList.toggle('hidden', mode !== 'harness');
  refresh();
}

// ── Your own stack (the "harness only" path) ─────────────────────────────────

function setStackPath(path) {
  state.stackPath = path;
  document.querySelectorAll('#stackPath .pill').forEach(p =>
    p.classList.toggle('active', p.dataset.stackpath === path));
  document.getElementById('stack-fields').classList.toggle('hidden', path !== 'custom');
  if (path === 'custom') renderStackFields();
  refresh();
}

// Mirror of the catalog rules (src/stack-catalog.js) — the terminal wizard
// revalidates everything; here it's display only:
//   database/ORM only exist as questions with the Hono backend (Convex embeds both);
//   Better Auth only without Convex; Convex Storage only with backend Convex/'depois';
//   Supabase Storage only with the Supabase database; "No ORM" doesn't apply to Hono.
function stackOptionVisible(catId, opt, choices) {
  const backend = choices.backend || 'depois';
  if (catId === 'auth' && opt.id === 'better-auth') return backend !== 'convex';
  if (catId === 'orm' && opt.id === 'none') return backend !== 'hono';
  if (catId === 'blob' && opt.id === 'convex-storage') return backend !== 'hono';
  if (catId === 'blob' && opt.id === 'supabase-storage') return (choices.database || '') === 'supabase';
  return true;
}

function renderStackFields() {
  const wrap = document.getElementById('stack-fields');
  wrap.innerHTML = '';
  const choices = state.stackChoices;
  for (const cat of (catalog.stack || [])) {
    if ((cat.id === 'database' || cat.id === 'orm') && (choices.backend || 'depois') !== 'hono') {
      delete choices[cat.id]; // Convex/'depois' decide these layers on their own
      continue;
    }
    const field = document.createElement('div');
    field.className = 'field';
    field.style.maxWidth = '420px';
    field.style.marginBottom = '10px';
    const label = document.createElement('label');
    label.className = 'small';
    label.textContent = cat.question;
    const select = document.createElement('select');
    select.style.width = '100%';
    const opts = cat.options.filter(o => stackOptionVisible(cat.id, o, choices));
    for (const o of opts) {
      const el = document.createElement('option');
      el.value = o.id;
      el.textContent = o.hint ? (o.label + ' — ' + o.hint) : o.label;
      select.appendChild(el);
    }
    const later = document.createElement('option');
    later.value = 'depois';
    later.textContent = 'Decide later (talking with Pi)';
    select.appendChild(later);
    const current = choices[cat.id];
    select.value = current && [...select.options].some(o => o.value === current) ? current : cat.defaultId;
    choices[cat.id] = select.value;
    select.onchange = () => {
      choices[cat.id] = select.value;
      renderStackFields(); // backend/database change what the other layers show
      refresh();
    };
    field.appendChild(label);
    field.appendChild(select);
    wrap.appendChild(field);
  }
}

let refreshSeq = 0;
async function refresh() {
  syncServices();
  // Sequence guard: rapid edits fire overlapping fetches and responses can
  // come back out of order — only the LATEST request may write the command.
  const seq = ++refreshSeq;
  try {
    const r = await fetch('/api/command', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(state),
    });
    const { command } = await r.json();
    if (seq !== refreshSeq) return; // stale response from an older edit
    if (command) document.getElementById('cmd').textContent = command;
  } catch {
    /* server busy/stopped — keep showing the last good command */
  }
}

async function copy() {
  // Persist pending key edits and refresh the command BEFORE copying —
  // otherwise a Copy right after pasting a key would go out without --keys.
  await flushKeys();
  await refresh();
  const text = document.getElementById('cmd').textContent;
  navigator.clipboard?.writeText(text).then(showCopied, showCopied);
}
function showCopied() {
  const c = document.getElementById('copied');
  c.classList.remove('hidden');
  setTimeout(() => c.classList.add('hidden'), 1600);
}

// ── Access (device flow) ─────────────────────────────────────────────────────

function setAuth(cls, text, showLogin) {
  const bar = document.getElementById('authbar');
  bar.className = 'authbar' + (cls ? ' ' + cls : '');
  document.getElementById('authText').textContent = text;
  document.getElementById('loginBtn').classList.toggle('hidden', !showLogin);
}

async function checkAuth() {
  try {
    const r = await fetch('/api/auth');
    const s = await r.json();
    if (s.authenticated) {
      const who = s.user && (s.user.name || s.user.email);
      setAuth('ok', who ? 'Access active — ' + who : 'Access active', false);
      return true;
    }
    if (s.reason === 'inactive') {
      setAuth('bad', s.message || 'Your subscription is not active.', false);
      return false;
    }
    setAuth('bad', 'You need to sign in with your community account.', true);
    return false;
  } catch {
    setAuth('bad', 'Could not verify your access.', true);
    return false;
  }
}

// Reads an NDJSON response event by event (the server does not buffer).
async function readNdjson(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try { onEvent(JSON.parse(line)); } catch { /* partial line: ignore */ }
    }
  }
}

async function doLogin() {
  const btn = document.getElementById('loginBtn');
  btn.disabled = true;
  setAuth('', 'Starting sign-in…', false);
  const panel = document.getElementById('devicePanel');
  try {
    const r = await fetch('/api/login', { method: 'POST' });
    await readNdjson(r, (ev) => {
      if (ev.type === 'pending') {
        panel.classList.remove('hidden');
        document.getElementById('deviceCode').textContent = ev.code || '····';
        const link = document.getElementById('deviceLink');
        link.href = ev.url;
        setAuth('', 'Waiting for you to authorize in the browser…', false);
        window.open(ev.url, '_blank', 'noopener');
      } else if (ev.type === 'ok') {
        panel.classList.add('hidden');
        const who = ev.user && (ev.user.name || ev.user.email);
        setAuth('ok', who ? 'Access active — ' + who : 'Access active', false);
      } else if (ev.type === 'error') {
        panel.classList.add('hidden');
        setAuth('bad', ev.message, true);
      }
    });
  } catch (err) {
    setAuth('bad', 'Sign-in failed: ' + err.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ── Open the terminal ────────────────────────────────────────────────────────
// The installation does NOT run on the page: the student copies the command and
// runs it in the terminal. This button asks the local server to open the
// system's terminal app (Terminal/Command Prompt/emulator) already in the project folder.

async function openTerm() {
  const btn = document.getElementById('termBtn');
  const status = document.getElementById('termStatus');
  btn.disabled = true;
  status.className = 'runstatus';
  status.textContent = 'Opening…';
  try {
    const r = await fetch('/api/open-terminal', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: state.dir }),
    });
    const data = await r.json();
    if (data.ok) {
      status.className = 'runstatus ok';
      status.textContent = 'Terminal open ✓ — now paste the command there and press Enter.';
    } else {
      status.className = 'runstatus bad';
      status.textContent = 'Could not open it automatically — open it yourself (tip below).';
    }
  } catch {
    status.className = 'runstatus bad';
    status.textContent = 'Could not open it automatically — open it yourself (tip below).';
  } finally {
    btn.disabled = false;
  }
}

boot();
checkAuth();
document.getElementById('loginBtn').addEventListener('click', doLogin);
document.getElementById('termBtn').addEventListener('click', openTerm);
</script>
</body>
</html>`;
}
