import fs from 'node:fs';
import path from 'node:path';
import { registry } from '../src/schemas/registry';

/** Serve the bundled integration schemas from disk, like the add-on's web server does. */
export function useBundledSchemas() {
  registry.setFetcher(async (p) => JSON.parse(fs.readFileSync(path.join(__dirname, '../public', p), 'utf8')));
}
