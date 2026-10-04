import fs from 'node:fs/promises';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const cfg = loadConfig();
await fs.mkdir(cfg.configDir, { recursive: true });
await fs.mkdir(cfg.dataDir, { recursive: true });

createApp(cfg).listen(cfg.port, cfg.host, () => {
  console.log(`HA Config Editor listening on ${cfg.host}:${cfg.port} (config: ${cfg.configDir})`);
});
