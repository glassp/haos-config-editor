# Config Editor for Home Assistant

A **mobile-first** file editor for Home Assistant OS, built to replace the VS Code Server add-on
when you mostly edit from a phone.

Why not VS Code Server? Monaco (and terminal emulators) draw their own text surface, so the phone's
native selection handles, magnifier and copy/paste menu don't work. This editor is built on
[CodeMirror 6](https://codemirror.net/), which edits a real `contenteditable`, so **long-press, drag handles,
double-tap word select, and the system Cut/Copy/Paste menu all work** — plus an explicit
clipboard toolbar for when you want one-tap actions.

## Features

| | |
|---|---|
| **Syntax highlighting** | YAML (with `{{ jinja }}` templates and `!secret`/`!include` tags), JSON, Python, JS, Markdown, shell, ini, Jinja |
| **Schema validation** | Built-in schemas for `automations.yaml`, `scripts.yaml`, `scenes.yaml`, `configuration.yaml` core keys and `packages/`; typo suggestions ("did you mean `trigger`?"); bring your own schemas per file glob |
| **HA-aware checks** | Unknown entities and actions (from your live instance), missing `!secret` keys, missing `!include` targets, YAML syntax and duplicate keys |
| **Auto-complete** | Schema-driven keys, entity IDs (with friendly names), actions/services and their data fields, `!secret` names, `!include` paths, loaded integrations, Jinja helpers |
| **Copy / paste** | Native selection + toolbar (copy, cut, paste, select all/line, copy file/path). Falls back to a paste box on plain-http installs where the clipboard API is blocked |
| **Mobile UI** | Bottom key bar above the keyboard (symbols `: - " [ ] { }`, indent, arrow keys with hold-to-repeat), tabs, file drawer, bottom sheets, safe-area aware, 16 px inputs (no iOS zoom) |
| **Safety** | Atomic saves, external-change conflict detection, per-file version history, unsaved drafts survive the browser killing the tab, `.storage` protected |
| **Explorer** | Root is `/` (paths like `/config/configuration.yaml`); opens `configuration.yaml` by default; visibility rules in Settings |
| **Tooltips** | Every toolbar action explains itself: hover on desktop, long-press on touch |
| **HA tools** | Check configuration, reload automations/scripts/scenes/core/templates |

### Not included: terminal

A web terminal would give this add-on shell access to the Home Assistant host container and a much larger
attack surface for something that sits behind a single ingress panel. It was deliberately left out. The
file editor only touches the Home Assistant folders listed under `/`.

## Install

1. In Home Assistant: **Settings → Add-ons → Add-on Store → ⋮ → Repositories**.
2. Add `https://github.com/glassp/haos-config-editor`.
3. Install **Config Editor**, start it, and enable **Show in sidebar**.

Works in the Home Assistant companion app, which is the point.

## Settings page

Open it from the file drawer (gear) or the ⋮ menu.

* **Explorer visibility** – by default everything under `/` is shown. Add ordered *show*/*hide* rules with glob
  patterns (`*`, `**`, `?`; a pattern without a leading `/` matches at any depth). The last matching rule wins and a
  rule on a folder covers everything inside it. A *Test a path* box tells you what a path resolves to. Hidden paths are
  only removed from the explorer and search: `!include`, `!secret` and validation still use them. Rules are stored in
  `/data/settings.json` so they follow you across devices.
* **Editor** – wrap, line numbers, auto-save and text size (stored on the device).

> `/` is the editor's virtual root. It lists only the Home Assistant folders in `allowed_roots`; the add-on's own
> `/data` and the rest of the container are never reachable.

## Splitting configuration: `# parse_config`

A fragment file can declare where it belongs in `configuration.yaml` so it is validated and auto-completed against
that part of the schema:

```yaml
# parse_config: logger.logs
homeassistant.components.mqtt: debug
```

* The file's whole content is treated as the value at that key path (`logger` → `logs`). Dots nest arbitrarily deep.
* Anything in `[...]` is ignored when resolving the schema: `entities[i]`, `entities[]`, `entities[0]` and
  `entities[item]` all mean `entities`, and `entities[i].configuration.options` resolves to
  `entities.configuration.options`. Lists are stepped through implicitly, so keys after a list address the list items.
* A path that *ends* in `[...]` also accepts a file that holds a single item instead of the list.
* The schema comes from the `/config/configuration.yaml` schema: the built-in one (`homeassistant`, `automation`,
  `script`, `scene`, `logger`, `http`, `recorder`) or your own via `.ha-editor/schemas.json` (see below). An unknown
  path produces a warning and the file is only syntax-checked.
* Typing `# parse_config: ` offers the available paths.

## Custom schemas

Create `/config/.ha-editor/schemas.json` mapping file globs (relative to `/config`, or absolute) to JSON Schema files. A schema for `configuration.yaml` also becomes the base for `parse_config` paths:

```json
{
  "configuration.yaml": ".ha-editor/configuration.schema.json",
  "blueprints/**/*.yaml": ".ha-editor/blueprint.schema.json",
  "esphome/*.yaml": ".ha-editor/esphome.schema.json"
}
```

Supported keywords: `type`, `properties`, `required`, `additionalProperties`, `patternProperties`, `items`,
`enum`, `const`, `minimum`/`maximum`, `minLength`, `pattern`, `minItems`, `allOf`, `anyOf`, `oneOf`, `not`,
`if`/`then`/`else`, local `$ref`. Schemas also drive key and value completion.

## Add-on options

| Option | Default | |
|---|---|---|
| `read_only` | `false` | Disable all writes |
| `allowed_roots` | config, share, ssl, media, addon_configs, addons | Top-level folders listed under `/` (must also be mapped into the add-on) |
| `allow_storage` | `false` | Allow reading/editing `.storage` (dangerous) |
| `max_file_size_kb` | `2048` | Larger files are refused |
| `history_limit` | `20` | Versions kept per file (`0` disables) |

## Security model

- Reachable only through Home Assistant **ingress** (requests from any address other than the Supervisor gateway are rejected) and restricted to admins (`panel_admin`).
- All paths are confined to the allowed folders under `/`; `..` and symlinks leaving a folder are refused. `.storage` stays write-protected unless `allow_storage` is on.
- Mutating requests need a custom header (CSRF), a strict CSP is set (no `eval`, no inline scripts).
- Secrets are never sent to the browser: only the *names* in `secrets.yaml` are exposed, for completion/validation.
- Only `*.reload*` services can be called; there is no restart or arbitrary service call.

## Development

```bash
cd config-editor
npm install
node dev/mock-ha.mjs &                       # fake HA API with a few entities/services
npm run build                                # builds web into server/public
ROOT_DIR=dev/sample-root DATA_DIR=.dev-data HA_URL=http://127.0.0.1:8123 HA_TOKEN=x \
  npm start -w server                        # http://127.0.0.1:8099
npm run dev -w web                           # optional: Vite dev server proxying /api
npm test && npm run typecheck
node web/e2e/smoke.mjs                       # mobile-emulated browser smoke test (needs Chromium)
```

Layout: `config-editor/server` (Express API, TypeScript) · `config-editor/web` (CodeMirror UI, Vite) ·
`config-editor/Dockerfile` (add-on image).
