import fs from 'node:fs/promises';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createSettings } from './settings.js';

const cfg = loadConfig();
await fs.mkdir(cfg.dataDir, { recursive: true });
const settings = createSettings(cfg.dataDir);
await settings.load();

createApp(cfg, undefined, settings).listen(cfg.port, cfg.host, () => {
  console.log(`HA Config Editor listening on ${cfg.host}:${cfg.port} (root: ${cfg.rootDir}, folders: ${cfg.allowedRoots.join(', ')})`);
});
