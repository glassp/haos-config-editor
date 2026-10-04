import { beforeAll, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { validateYaml } from '../src/ha/validate';
import { prepareSchemas } from '../src/ha/prepare';
import { completeYaml, filePathFacet } from '../src/ha/complete';
import { registry } from '../src/schemas/registry';
import { ctx } from '../src/ha/context';
import { useBundledSchemas } from './helpers';

beforeAll(() => useBundledSchemas());

async function problems(text: string, file = '/config/configuration.yaml') {
  await prepareSchemas(text, file);
  return validateYaml(text, file, ctx).map((p) => p.message);
}
async function labels(doc: string, file = '/config/configuration.yaml') {
  const pos = doc.indexOf('|');
  const text = doc.replace('|', '');
  await prepareSchemas(text, file);
  const state = EditorState.create({ doc: text, extensions: [filePathFacet.of(file)] });
  const r = completeYaml(new CompletionContext(state, pos, true));
  return r ? r.options.map((o) => o.label) : [];
}

describe('bundled integration schemas', () => {
  it('knows the integrations Home Assistant can configure in YAML', async () => {
    await registry.init();
    expect(registry.haVersion).toMatch(/^\d{4}\./);
    for (const d of ['notify', 'sensor', 'light', 'mqtt', 'logger', 'http', 'recorder', 'homeassistant', 'template', 'rest', 'command_line', 'input_boolean', 'group', 'influxdb', 'modbus', 'knx']) {
      expect(registry.index[d], d).toBeTruthy();
    }
    expect(Object.keys(registry.index).length).toBeGreaterThan(200);
  });

  it('loads schemas lazily, only for the keys a document uses', async () => {
    registry.reset();
    await prepareSchemas('notify:\n  - platform: smtp\nsensor: !include s.yaml\n', '/config/configuration.yaml');
    expect(registry.isLoaded('notify')).toBe(true);
    expect(registry.isLoaded('sensor')).toBe(true);
    expect(registry.isLoaded('light')).toBe(false);
  });
});

describe('configuration.yaml validation', () => {
  it('accepts a correct notify platform config and checks its required keys', async () => {
    const ok = 'notify:\n  - platform: smtp\n    name: mail\n    server: smtp.example.org\n    port: 587\n    sender: a@b.c\n    recipient:\n      - x@y.z\n';
    expect(await problems(ok)).toEqual([]);
    expect(await problems('notify:\n  - platform: smtp\n    server: x\n')).toEqual(expect.arrayContaining(['Missing required key "sender"', 'Missing required key "recipient"']));
    expect(await problems('notify:\n  - platform: smtp\n    sender: a\n    recipient: b\n    port: 99999\n')).toContain('Must be at most 65535');
    expect(await problems('notify:\n  - name: no platform\n')).toContain('Missing required key "platform"');
  });

  it('leaves unknown (custom) platforms alone', async () => {
    expect(await problems('notify:\n  - platform: my_custom_notifier\n    whatever: 1\n')).toEqual([]);
  });

  it('validates platform-based sensors (template, rest)', async () => {
    const ok = "sensor:\n  - platform: template\n    sensors:\n      power:\n        value_template: '{{ 1 }}'\n        unit_of_measurement: W\n";
    expect(await problems(ok)).toEqual([]);
    expect((await problems("sensor:\n  - platform: template\n    sensors:\n      power:\n        value_templat: '{{ 1 }}'\n")).join()).toMatch(/Unknown key "value_templat"/);
  });

  it('validates core and well-known integrations', async () => {
    expect(await problems('homeassistant:\n  unit_system: parsecs\n')).toEqual([expect.stringMatching(/Must be one of/)]);
    expect(await problems('http:\n  server_port: 99999\n')).toContain('Must be at most 65535');
    expect(await problems('http:\n  server_port: 8123\n  use_x_forwarded_for: true\n  trusted_proxies:\n    - 172.30.33.0/24\n')).toEqual([]);
    expect(await problems('recorder:\n  purge_keep_days: 0\n')).toContain('Must be at least 1');
    expect((await problems('recorder:\n  purge_keep_dayz: 5\n')).join()).toMatch(/Unknown key "purge_keep_dayz" — did you mean "purge_keep_days"/);
  });

  it('accepts what Home Assistant accepts: any casing for log levels, numeric strings, list-or-single values', async () => {
    expect(await problems('logger:\n  default: warning\n  logs:\n    homeassistant.core: Debug\n')).toEqual([]);
    expect((await problems('logger:\n  default: shouting\n'))[0]).toMatch(/Must be one of/);
    expect(await problems("http:\n  server_port: '8123'\n  cors_allowed_origins: https://x.example\n")).toEqual([]);
    expect(await problems('http:\n  cors_allowed_origins:\n    - https://x.example\n')).toEqual([]);
  });

  it('validates slug-keyed maps such as input_boolean and counter', async () => {
    expect(await problems('input_boolean:\n  guest_mode:\n    name: Guest\n    icon: mdi:account\n    initial: false\n')).toEqual([]);
    expect((await problems('input_boolean:\n  guest_mode:\n    nme: Guest\n')).join()).toMatch(/Unknown key "nme"/);
    expect((await problems('counter:\n  visits:\n    step: -1\n')).join()).toMatch(/Must be at least 0/);
  });

  it('keeps the hand-written automation, script and scene schemas', async () => {
    expect((await problems('automation:\n  - alias: a\n    triger: []\n    action: []\n')).join()).toMatch(/did you mean "trigger"/);
  });

  it('ignores !include / !secret values', async () => {
    ctx.paths = new Set(['/config/n.yaml']);
    ctx.secrets = new Set(['pw']);
    expect(await problems('notify: !include n.yaml\nrecorder:\n  db_url: !secret pw\n')).toEqual([]);
  });
});

describe('parse_config with integration schemas', () => {
  it('no longer warns for notify (and validates the fragment)', async () => {
    const ok = '# parse_config: notify\n- platform: smtp\n  sender: a@b.c\n  recipient: x@y.z\n';
    expect(await problems(ok, '/config/notify.yaml')).toEqual([]);
    const bad = await problems('# parse_config: notify\n- platform: smtp\n  server: s\n', '/config/notify.yaml');
    expect(bad.join()).not.toMatch(/no schema known/);
    expect(bad).toContain('Missing required key "sender"');
  });

  it('resolves nested paths into integrations', async () => {
    expect(await problems('# parse_config: sensor\n- platform: template\n  sensors: {}\n', '/config/s.yaml')).toEqual([]);
    expect(await problems('# parse_config: http.trusted_proxies\n- 172.30.33.0/24\n', '/config/p.yaml')).toEqual([]);
    expect(await problems('# parse_config: homeassistant.customize\nlight.x:\n  friendly_name: X\n', '/config/c.yaml')).toEqual([]);
    expect((await problems('# parse_config: http.server_port\n99999\n', '/config/p.yaml'))[0]).toMatch(/at most 65535/);
  });

  it('works for any known integration key, and still warns for unknown ones', async () => {
    expect((await problems('# parse_config: totally_unknown\na: 1\n', '/config/u.yaml'))[0]).toMatch(/no schema known/);
  });
});

describe('completion with integration schemas', () => {
  it('suggests top-level integrations from the index', async () => {
    expect(await labels('noti|')).toContain('notify');
    expect(await labels('rec|')).toContain('recorder');
  });
  it('suggests platform names and platform specific keys', async () => {
    expect(await labels('notify:\n  - platform: |')).toEqual(expect.arrayContaining(['smtp', 'group']));
    const keys = await labels('notify:\n  - platform: smtp\n    |');
    expect(keys).toEqual(expect.arrayContaining(['server', 'recipient', 'sender', 'encryption']));
    expect(keys).not.toContain('platform');
    expect(await labels('notify:\n  - platform: smtp\n    encryption: |')).toEqual(expect.arrayContaining(['tls', 'starttls']));
  });
  it('suggests keys inside plain integrations and in parse_config fragments', async () => {
    expect(await labels('recorder:\n  purge|')).toEqual(expect.arrayContaining(['purge_keep_days', 'purge_interval']));
    expect(await labels('# parse_config: recorder\nauto|', '/config/r.yaml')).toContain('auto_purge');
    expect(await labels('# parse_config: notify\n- platform: smtp\n  rec|', '/config/n.yaml')).toContain('recipient');
  });
  it('completes parse_config paths with every integration', async () => {
    expect(await labels('# parse_config: |', '/config/x.yaml')).toEqual(expect.arrayContaining(['notify', 'sensor', 'logger']));
    expect(await labels('# parse_config: recorder.|', '/config/x.yaml')).toContain('purge_keep_days');
  });
});

describe('realistic configuration', () => {
  it('produces no false positives for commonly used integrations', async () => {
    const cfg = `
homeassistant:
  name: Home
  latitude: 52.5
  longitude: 13.4
  elevation: 34
  unit_system: metric
  currency: EUR
  time_zone: Europe/Berlin
  country: DE
  external_url: https://ha.example.org
  customize:
    light.kitchen:
      friendly_name: Kitchen
  packages: !include_dir_named packages
default_config:
http:
  use_x_forwarded_for: true
  trusted_proxies:
    - 172.30.33.0/24
    - ::1
  ip_ban_enabled: true
  login_attempts_threshold: 5
logger:
  default: warning
  logs:
    homeassistant.components.mqtt: debug
recorder:
  purge_keep_days: 14
  commit_interval: 5
  exclude:
    domains: [automation, updater]
    entity_globs:
      - sensor.weather_*
    entities:
      - sun.sun
history:
  exclude:
    domains: [sun]
input_boolean:
  guest_mode:
    name: Guest mode
    initial: false
input_number:
  target_temp:
    min: 15
    max: 25
    step: 0.5
    mode: slider
    unit_of_measurement: °C
input_select:
  scene_mode:
    options: [day, night]
    initial: day
input_datetime:
  alarm:
    has_date: false
    has_time: true
counter:
  doorbell:
    initial: 0
    step: 1
timer:
  laundry:
    duration: '00:45:00'
group:
  downstairs:
    name: Downstairs
    entities:
      - light.kitchen
      - light.hall
sensor:
  - platform: template
    sensors:
      outside_temp:
        friendly_name: Outside
        unit_of_measurement: °C
        value_template: "{{ states('sensor.t') | float }}"
  - platform: command_line
    name: cpu temp
    command: cat /sys/class/thermal/thermal_zone0/temp
    unit_of_measurement: °C
    scan_interval: 30
  - platform: rest
    resource: https://example.org/api
    name: Example
    value_template: "{{ value_json.x }}"
    scan_interval: 600
binary_sensor:
  - platform: template
    sensors:
      door_open:
        value_template: "{{ is_state('binary_sensor.door', 'on') }}"
        device_class: door
switch:
  - platform: template
    switches:
      pump:
        value_template: "{{ is_state('sensor.p', 'on') }}"
        turn_on:
          service: switch.turn_on
          target:
            entity_id: switch.p
        turn_off:
          service: switch.turn_off
          target:
            entity_id: switch.p
light:
  - platform: group
    name: All lights
    entities:
      - light.kitchen
      - light.hall
notify:
  - platform: group
    name: everyone
    services:
      - action: mobile_app_phone
template:
  - sensor:
      - name: Power
        state: "{{ 1 + 1 }}"
        unit_of_measurement: W
  - binary_sensor:
      - name: Awake
        state: "{{ true }}"
shell_command:
  restart_x: systemctl restart x
rest_command:
  call_api:
    url: https://example.org/{{ x }}
    method: post
    payload: '{"a": 1}'
mqtt:
  sensor:
    - name: Temp
      state_topic: home/temp
      unit_of_measurement: °C
  switch:
    - name: Relay
      command_topic: home/relay/set
automation: !include automations.yaml
script: !include scripts.yaml
scene: !include scenes.yaml
frontend:
  themes: !include_dir_merge_named themes
`;
    ctx.paths = new Set(['/config/automations.yaml', '/config/scripts.yaml', '/config/scenes.yaml', '/config/packages/a.yaml', '/config/themes/t.yaml']);
    expect(await problems(cfg)).toEqual([]);
  });
});
