# Changelog

## 0.4.0

- Full integration schemas: `configuration.yaml` and `parse_config` fragments are now validated and completed against
  schemas generated from Home Assistant itself (220 integrations incl. all entity platforms such as `notify`,
  `sensor`, `light`; `homeassistant`, `http`, `recorder`, `logger`, `template`, `mqtt`, …). Fixes
  "parse_config: no schema known for notify".
- Toolbar reduced to Undo, Redo, Indent and Outdent (selection/copy/paste use the native phone controls).
- Better validation messages (nullable values, one-of alternatives, case-insensitive enums such as log levels).

## 0.3.0

- Explorer root is now `/` (paths are absolute, e.g. `/config/configuration.yaml`) and lists the Home Assistant
  folders `/config`, `/share`, `/ssl`, `/media`, `/addon_configs`, `/addons`. The editor opens
  `/config/configuration.yaml` by default.
- New Settings page: explorer visibility rules (show/hide by glob; last match wins; hidden paths stay available to
  includes, secrets and validation), editor preferences, status.
- Tooltips on every toolbar action: hover on desktop, long-press on touch.
- `# parse_config: <path>` directive: validate and complete a file as a fragment of `configuration.yaml`
  (dot notation, list markers `[...]` ignored).
- Add-on: new `allowed_roots` option replaces `show_hidden`; additional folders are mapped (config, share, media,
  ssl read-only, addon_configs, addons).

## 0.2.0

- New tab model: phones show the file name as a title plus a Chrome-style tab switcher; wide screens show
  5 quick-switch tabs. Tabs can be pinned (kept in quick switch, shown in a Pinned section). The popup lists all open tabs.
- UI refresh: translucent top/key bars, rounder surfaces, accent save button, softer drawer and sheets.

## 0.1.1

- Fix add-on startup: container environment is now passed to the server, so it listens on
  all interfaces and edits `/config` (previously ingress returned 502).

## 0.1.0

- Initial release: mobile-first CodeMirror editor, YAML highlighting, Home Assistant aware
  completion and validation, native text selection plus clipboard toolbar, file manager,
  version history, config check and reload.
