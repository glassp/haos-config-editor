import { beforeAll, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { filePathFacet, completeYaml as yamlCompletions } from '../src/ha/complete';
import { registry } from '../src/schemas/registry';
import { useBundledSchemas } from './helpers';
import { ctx } from '../src/ha/context';

beforeAll(async () => {
  useBundledSchemas();
  await registry.init();
});

ctx.entities = [
  { entity_id: 'light.kitchen', name: 'Kitchen', state: 'on' },
  { entity_id: 'sensor.temp', name: 'Temp', state: '3' },
];
ctx.entityDomains = new Set(['light', 'sensor']);
ctx.secrets = new Set(['wifi_pw']);
ctx.paths = new Set(['configuration.yaml', 'automations.yaml', 'packages/a.yaml']);
ctx.services = {
  light: { turn_on: { name: 'Turn on', fields: { brightness: { name: 'Brightness' }, advanced: { fields: { effect: {} } } as never } } },
};
ctx.components = ['light', 'mqtt', 'sensor.mqtt'];

function labels(doc: string, file = 'automations.yaml') {
  const pos = doc.indexOf('|');
  const text = doc.replace('|', '');
  const state = EditorState.create({ doc: text, extensions: [filePathFacet.of(file)] });
  const r = yamlCompletions(new CompletionContext(state, pos, true));
  return r ? r.options.map((o) => o.label) : [];
}

describe('yaml completions', () => {
  it('offers automation keys at the top of an item', () => {
    const l = labels('- alias: x\n  tri|');
    expect(l).toContain('trigger');
    expect(l).toContain('action');
    expect(l).not.toContain('alias'); // already present
  });
  it('offers platform-specific keys once platform is known', () => {
    const l = labels('- alias: x\n  trigger:\n    - platform: state\n      |');
    expect(l).toContain('entity_id');
    expect(l).toContain('to');
    expect(l).not.toContain('topic');
  });
  it('offers platform names and enums as values', () => {
    expect(labels('- trigger:\n    - platform: |')).toContain('numeric_state');
    expect(labels('- alias: a\n  mode: |')).toContain('restart');
  });
  it('offers entity ids for entity_id values, dash items and typed domains', () => {
    expect(labels('- trigger:\n  - platform: state\n    entity_id: |')).toContain('light.kitchen');
    expect(labels('- trigger:\n  - platform: state\n    entity_id:\n      - |')).toContain('sensor.temp');
    expect(labels("- condition: template\n  value_template: \"{{ states('sensor.t|') }}\"")).toEqual(['sensor.temp']);
  });
  it('offers services and their data fields', () => {
    expect(labels('- action:\n  - service: |')).toContain('light.turn_on');
    const l = labels('- action:\n  - service: light.turn_on\n    data:\n      |');
    expect(l).toEqual(expect.arrayContaining(['brightness', 'effect']));
  });
  it('offers HA tags and their arguments', () => {
    expect(labels('password: !|', 'configuration.yaml')).toContain('!secret');
    expect(labels('password: !secret |', 'configuration.yaml')).toEqual(['wifi_pw']);
    expect(labels('automation: !include |', 'configuration.yaml')).toContain('automations.yaml');
    expect(labels('x: !include |', 'packages/b.yaml')).toContain('a.yaml');
  });
  it('offers loaded integrations at the top level of configuration.yaml', () => {
    const l = labels('mq|', 'configuration.yaml');
    expect(l).toContain('mqtt');
    expect(l).toContain('homeassistant');
  });
});
