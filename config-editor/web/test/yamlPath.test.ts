import { describe, expect, it } from 'vitest';
import { ITEM, pathFor, siblingScalars } from '../src/ha/yamlPath';

const L = (s: string) => s.split('\n');

describe('pathFor', () => {
  it('finds nested mapping path', () => {
    const lines = L('automation:\n  - alias: x\n    trigger:\n      - platform: state\n        for:\n          ');
    expect(pathFor(lines, 5).path).toEqual(['automation', ITEM, 'trigger', ITEM, 'for']);
  });
  it('handles a key on a dash line', () => {
    const lines = L('automation:\n  - alias: x\n    trigger:\n      - plat');
    expect(pathFor(lines, 3).path).toEqual(['automation', ITEM, 'trigger', ITEM]);
  });
  it('handles indentless sequences', () => {
    const lines = L('automation:\n- alias: x\n  action:\n  - service: a\n    data:\n      ');
    expect(pathFor(lines, 5).path).toEqual(['automation', ITEM, 'action', ITEM, 'data']);
  });
  it('handles root lists (automations.yaml)', () => {
    const lines = L('- id: "1"\n  alias: a\n  action:\n  - service: light.turn_on\n    target:\n      ');
    expect(pathFor(lines, 5).path).toEqual([ITEM, 'action', ITEM, 'target']);
  });
  it('is not confused by sibling items', () => {
    const lines = L('a:\n  b:\n    - x: 1\n    - y: 2\n  c:\n    ');
    expect(pathFor(lines, 5).path).toEqual(['a', 'c']);
  });
  it('handles scalar list items under a key', () => {
    const lines = L('trigger:\n  - platform: state\n    entity_id:\n      - light.a\n      - ');
    expect(pathFor(lines, 4).path).toEqual(['trigger', ITEM, 'entity_id', ITEM]);
  });
  it('top level', () => {
    expect(pathFor(L('homeassistant:\n  name: x\n'), 2).path).toEqual([]);
  });
});

describe('siblingScalars', () => {
  it('collects scalars from the same list item only', () => {
    const lines = L('- service: light.turn_on\n  data:\n    br: 1\n- service: other.x\n  data:\n    ');
    expect(siblingScalars(lines, 1)).toEqual({ service: 'light.turn_on' });
    expect(siblingScalars(lines, 4)).toEqual({ service: 'other.x' });
  });
});
