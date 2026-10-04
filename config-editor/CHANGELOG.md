# Changelog

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
