import { describe, expect, it } from 'vitest';
import { validateYaml } from '../src/ha/validate';
import type { HaContext } from '../src/ha/context';

const base = (over: Partial<HaContext> = {}): HaContext => ({
  connected: true,
  entities: [],
  entityIds: new Set(['light.kitchen']),
  entityDomains: new Set(['light']),
  services: { light: { turn_on: {} } },
  components: [],
  secrets: new Set(['wifi']),
  paths: new Set(['configuration.yaml', 'automations.yaml', 'packages/a.yaml']),
  customSchemas: {},
  ...over,
});
const msgs = (text: string, file: string, c = base()) => validateYaml(text, file, c).map((p) => p.message);

describe('validateYaml', () => {
  it('reports syntax errors', () => {
    expect(msgs('a: [1, 2\nb: 3', 'x.yaml').length).toBeGreaterThan(0);
  });
  it('reports duplicate keys', () => {
    expect(msgs('a: 1\na: 2\n', 'x.yaml').join()).toMatch(/unique|duplicate/i);
  });
  it('accepts HA tags and checks secrets', () => {
    expect(msgs('pw: !secret wifi\n', 'x.yaml')).toEqual([]);
    expect(msgs('pw: !secret nope\n', 'x.yaml')).toEqual(['Secret "nope" is not defined in secrets.yaml']);
  });
  it('checks !include targets relative to the file', () => {
    expect(msgs('automation: !include automations.yaml\n', 'configuration.yaml')).toEqual([]);
    expect(msgs('automation: !include missing.yaml\n', 'configuration.yaml')[0]).toMatch(/does not exist/);
    expect(msgs('x: !include a.yaml\n', 'packages/b.yaml')).toEqual([]);
  });
  it('flags unknown entities and services', () => {
    const t = '- alias: a\n  trigger:\n    - platform: state\n      entity_id: light.nope\n  action:\n    - service: light.explode\n';
    const m = msgs(t, 'automations.yaml');
    expect(m).toContain('Unknown entity "light.nope"');
    expect(m).toContain('Unknown action "light.explode"');
  });
  it('validates a good automation without noise', () => {
    const t = `- id: '1'
  alias: Lights
  mode: single
  trigger:
    - platform: state
      entity_id: light.kitchen
      to: 'on'
      for: { minutes: 5 }
  condition:
    - condition: time
      after: '18:00:00'
    - "{{ is_state('light.kitchen', 'on') }}"
  action:
    - service: light.turn_on
      target: { entity_id: light.kitchen }
      data: { brightness: 100 }
    - choose:
        - conditions: [{ condition: state, entity_id: light.kitchen, state: 'on' }]
          sequence:
            - delay: '00:00:05'
      default: []
`;
    expect(msgs(t, 'automations.yaml')).toEqual([]);
  });
  it('catches typos with suggestions', () => {
    const t = '- alias: a\n  triger:\n    - platform: state\n      entity_id: light.kitchen\n  action: []\n';
    expect(msgs(t, 'automations.yaml')).toContain('Unknown key "triger" — did you mean "trigger"?');
  });
  it('catches missing required and bad enum values', () => {
    const t = '- alias: a\n  mode: loop\n  trigger:\n    - platform: state\n  action: []\n';
    const m = msgs(t, 'automations.yaml');
    expect(m.some((x) => x.startsWith('Must be one of: single'))).toBe(true);
    expect(m).toContain('Missing required key "entity_id"');
  });
  it('rejects unknown action keys', () => {
    const t = '- alias: a\n  trigger: []\n  action:\n    - servce: light.turn_on\n';
    expect(msgs(t, 'automations.yaml').join()).toMatch(/Unknown key "servce"/);
  });
  it('validates scripts and scenes', () => {
    expect(msgs('s:\n  alias: x\n  sequence:\n    - delay: 5\n', 'scripts.yaml')).toEqual([]);
    expect(msgs('- id: 1\n  entities: {}\n', 'scenes.yaml')).toContain('Missing required key "name"');
  });
  it('validates configuration.yaml core keys', () => {
    expect(msgs('homeassistant:\n  unit_system: parsecs\n', 'configuration.yaml')[0]).toMatch(/Must be one of/);
    expect(msgs('homeassistant:\n  name: Home\nfoo_integration:\n  x: 1\n', 'configuration.yaml')).toEqual([]);
  });
  it('does not complain about include-tagged values', () => {
    expect(msgs('homeassistant:\n  customize: !include customize.yaml\nautomation: !include automations.yaml\n', 'configuration.yaml', base({ paths: new Set(['customize.yaml', 'automations.yaml']) }))).toEqual([]);
  });
});
