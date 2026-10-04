# Changelog

## 0.1.1

- Fix add-on startup: container environment is now passed to the server, so it listens on
  all interfaces and edits `/config` (previously ingress returned 502).

## 0.1.0

- Initial release: mobile-first CodeMirror editor, YAML highlighting, Home Assistant aware
  completion and validation, native text selection plus clipboard toolbar, file manager,
  version history, config check and reload.
