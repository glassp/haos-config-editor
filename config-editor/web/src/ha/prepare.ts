import { configRel } from '../schemas';
import { registry } from '../schemas/registry';
import { findDirective } from './parseConfig';

/**
 * Load the integration schemas a document needs before it is validated or completed:
 * the top-level keys of configuration.yaml / packages, or the first segment of a parse_config path.
 */
export async function prepareSchemas(text: string, filePath: string, extra: string[] = []): Promise<void> {
  await registry.init();
  const domains = new Set<string>(extra);
  const dir = findDirective(text);
  if (dir && !dir.error) domains.add(dir.segments[0]);
  const rel = configRel(filePath);
  if (rel === 'configuration.yaml' || rel.startsWith('packages/')) {
    for (const m of text.matchAll(/^([A-Za-z0-9_]+)[ \t]*:/gm)) domains.add(m[1]);
  }
  await registry.ensure(domains);
}
