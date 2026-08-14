# Install FIA

FIA is stamped by `impactus` into `imp/` and `.pi/`. To verify:

```bash
test -d imp/modules && test -f imp/fia.config.yaml && echo ok
pi --version
claude --version
```

Install Pi packages:

```bash
pi install npm:pi-subagents
pi install npm:pi-mcp-adapter
pi install npm:pi-web-access
```

Login (once per machine):

```bash
claude          # Claude Pro/Max subscription
pi
/login openai-codex
```

Smoke:

```bash
node imp/fda_quality.mjs "quality gate"
```
