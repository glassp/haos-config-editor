import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { findDirective, parseDirectivePath, schemaContext } from '../src/ha/parseConfig';
import { resolvePath } from '../src/ha/schemaWalk';
import { validateYaml } from '../src/ha/validate';
import { filePathFacet, completeYaml as yamlCompletions } from '../src/ha/complete';
import { registry } from '../src/schemas/registry';
import { useBundledSchemas } from './helpers';
import { ctx } from '../src/ha/context';
import { configurationFile } from '../src/schemas/ha';

// A user schema for configuration.yaml with the structures from the feature request.
const userRoot = {
  type: 'object',
  $defs: {
    entity: {
      type: 'object',
      properties: {
        entity_id: { type: 'string' },
        name: { type: 'string' },
        configuration: {
          type: 'object',
          properties: { options: { type: 'object', properties: { level: { enum: ['low', 'high'] } }, additionalProperties: false } },
        },
      },
      required: ['entity_id'],
      additionalProperties: false,
    },
  },
  properties: {
    entities: { type: 'array', items: { $ref: '#/$defs/entity' } },
    foo: { type: 'object', properties: { bar: { type: 'object', properties: { baz: { type: 'object', properties: { qux: { type: 'integer' } } } } } } },
    ...(configurationFile as { properties: object }).properties,
  },
};

beforeAll(async () => {
  useBundledSchemas();
  await registry.ensure(['logger', 'notify', 'homeassistant']);
});

const messages = (text: string, file = '/config/entities/bedroom.yaml') => validateYaml(text, file, ctx).map((p) => p.message);
const withUser = () => (ctx.customSchemas = { 'configuration.yaml': userRoot });
afterEach(() => (ctx.customSchemas = {}));

describe('parseDirectivePath', () => {
  it('ignores everything in brackets', () => {
    for (const raw of ['entities[i]', 'entities[]', 'entities[0]', 'entities[item]', 'entities']) {
      expect(parseDirectivePath(raw).segments).toEqual(['entities']);
    }
    expect(parseDirectivePath('entities[i].configuration.options').segments).toEqual(['entities', 'configuration', 'options']);
    expect(parseDirectivePath('foo.bar.baz.qux').segments).toEqual(['foo', 'bar', 'baz', 'qux']);
  });
  it('detects a trailing list marker', () => {
    expect(parseDirectivePath('entities[i]').trailingList).toBe(true);
    expect(parseDirectivePath('entities[i].x').trailingList).toBe(false);
    expect(parseDirectivePath('entities').trailingList).toBe(false);
  });
  it('rejects malformed paths', () => {
    for (const raw of ['', 'a..b', 'a[', 'a]', 'a.b c', '.a']) expect(parseDirectivePath(raw).error).toBeTruthy();
  });
});

describe('findDirective', () => {
  it('finds the comment anywhere and only as a comment', () => {
    expect(findDirective('# parse_config: logger.logs\na: 1')?.segments).toEqual(['logger', 'logs']);
    expect(findDirective('\n\n  #parse_config:entities\n- a')?.segments).toEqual(['entities']);
    expect(findDirective('key: "# parse_config: nope"')).toBeNull();
    expect(findDirective('a: 1')).toBeNull();
  });
});

describe('schema resolution', () => {
  it('resolves nested paths and steps through lists implicitly', () => {
    expect(resolvePath(userRoot, ['foo', 'bar', 'baz', 'qux'])).toEqual({ type: 'integer' });
    const options = resolvePath(userRoot, ['entities', 'configuration', 'options']);
    expect(options?.properties.level.enum).toEqual(['low', 'high']);
    expect(resolvePath(userRoot, ['entities', 'nope'])).toBeNull();
    expect(resolvePath(userRoot, ['missing'])).toBeNull();
  });
  it('resolves built-in HA paths', () => {
    const root = registry.root();
    expect(resolvePath(root, ['logger', 'logs'])).toBeTruthy();
    expect(resolvePath(root, ['automation', 'action'])).toBeTruthy(); // through the list of automations
  });
  it('gives every bracket spelling the same schema', () => {
    const a = schemaContext('# parse_config: entities[i]\n', '/config/x.yaml');
    withUser();
    const schemas = ['entities', 'entities[]', 'entities[0]', 'entities[item]'].map((p) => schemaContext(`# parse_config: ${p}\n`, '/config/x.yaml')?.schema);
    expect(a).toBeNull(); // built-in schema has no "entities"
    for (const s of schemas) expect(s).toBe(schemas[0]);
  });
});

describe('validation with parse_config', () => {
  it('validates a list fragment against the entities schema', () => {
    withUser();
    expect(messages('# parse_config: entities\n\n- entity_id: light.bedroom\n  name: Bedroom\n')).toEqual([]);
    const bad = messages('# parse_config: entities\n- name: Bedroom\n  colour: red\n');
    expect(bad).toContain('Missing required key "entity_id"');
    expect(bad.join()).toMatch(/Unknown key "colour"/);
  });
  it('accepts a single item when the path ends in [i]', () => {
    withUser();
    expect(messages('# parse_config: entities[i]\nentity_id: light.a\nname: A\n')).toEqual([]);
    expect(messages('# parse_config: entities[i]\n- entity_id: light.a\n')).toEqual([]);
    expect(messages('# parse_config: entities[i]\nname: A\n')).toContain('Missing required key "entity_id"');
  });
  it('validates nested list paths', () => {
    withUser();
    expect(messages('# parse_config: entities[i].configuration.options\nlevel: high\n')).toEqual([]);
    expect(messages('# parse_config: entities[i].configuration.options\nlevel: medium\n')[0]).toMatch(/Must be one of: low, high/);
    expect(messages('# parse_config: foo.bar.baz.qux\n12\n')).toEqual([]);
    expect(messages('# parse_config: foo.bar.baz.qux\nhello\n')).toContain('Expected integer');
  });
  it('uses the built-in configuration schema, including its lists', () => {
    expect(messages('# parse_config: logger.logs\nhomeassistant.core: debug\nx: shouting\n')[0]).toMatch(/Must be one of/);
    expect(messages('# parse_config: logger.logs\nhomeassistant.core: DEBUG\nother: Warning\n')).toEqual([]);
    expect(messages('# parse_config: logger.logs\nhomeassistant.core: debug\n')).toEqual([]);
    expect(messages('# parse_config: automation\n- alias: a\n  trigger: []\n  action: []\n')).toEqual([]);
    expect(messages('# parse_config: automation\n- alias: a\n  triger: []\n  action: []\n').join()).toMatch(/did you mean "trigger"/);
    expect(messages('# parse_config: automation.action\n- servce: x\n').join()).toMatch(/Unknown key "servce"/);
  });
  it('warns when the path is unknown and reports malformed directives', () => {
    const m = messages('# parse_config: nothing.here\na: 1\n');
    expect(m[0]).toMatch(/no schema known for "nothing.here"/);
    expect(messages('# parse_config:\na: 1\n')[0]).toMatch(/needs a path/);
    expect(messages('# parse_config: a..b\n')[0]).toMatch(/Empty segment/);
  });
  it('still reports plain YAML errors in fragments', () => {
    expect(messages('# parse_config: logger.logs\na: [1\n').length).toBeGreaterThan(0);
  });
});

describe('completion with parse_config', () => {
  const labels = (doc: string) => {
    const pos = doc.indexOf('|');
    const state = EditorState.create({ doc: doc.replace('|', ''), extensions: [filePathFacet.of('/config/entities/b.yaml')] });
    const r = yamlCompletions(new CompletionContext(state, pos, true));
    return r ? r.options.map((o) => o.label) : [];
  };
  it('completes item keys from the referenced schema', () => {
    withUser();
    expect(labels('# parse_config: entities\n- entity_id: x\n  na|')).toEqual(expect.arrayContaining(['name', 'configuration']));
    expect(labels('# parse_config: entities\n- entity_id: x\n  na|')).not.toContain('entity_id');
    expect(labels('# parse_config: entities[i]\nna|')).toContain('name'); // single item form
    expect(labels('# parse_config: entities[i].configuration.options\nle|')).toContain('level');
    expect(labels('# parse_config: entities[i].configuration.options\nlevel: |')).toEqual(['low', 'high']);
  });
  it('completes the directive path itself', () => {
    withUser();
    expect(labels('# parse_config: |')).toEqual(expect.arrayContaining(['entities', 'foo', 'automation']));
    expect(labels('# parse_config: foo.|')).toEqual(['bar']);
    expect(labels('# parse_config: entities.|')).toEqual(expect.arrayContaining(['entity_id', 'configuration']));
  });
});
