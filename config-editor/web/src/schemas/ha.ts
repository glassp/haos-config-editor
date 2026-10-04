/* JSON Schemas for the Home Assistant YAML dialects the editor knows about.
 * They are deliberately strict where HA is strict (typos in automation keys) and
 * permissive where HA accepts many shapes (templates, selectors, device payloads). */

type S = Record<string, unknown>;

const string: S = { type: 'string' };
const bool: S = { type: 'boolean' };
const scalar: S = { type: ['string', 'number', 'boolean'] };
const strOrList: S = { type: ['string', 'array'], items: { type: 'string' } };
const entityIds: S = strOrList;
const numOrTemplate: S = { type: ['number', 'string'] };
const duration: S = {
  type: ['string', 'number', 'object'],
  properties: {
    days: numOrTemplate,
    hours: numOrTemplate,
    minutes: numOrTemplate,
    seconds: numOrTemplate,
    milliseconds: numOrTemplate,
  },
  additionalProperties: false,
};
const target: S = {
  type: 'object',
  properties: { entity_id: entityIds, device_id: strOrList, area_id: strOrList, floor_id: strOrList, label_id: strOrList },
  additionalProperties: false,
};

const common = { alias: string, enabled: bool, id: string, variables: { type: 'object' } };

/** One discriminated variant: `key == value` selects the property set. */
function variant(key: string, value: string, props: Record<string, S>, required: string[] = [], open = false): S {
  return {
    if: { properties: { [key]: { const: value } }, required: [key] },
    then: {
      properties: { ...common, [key]: string, ...props },
      required,
      ...(open ? {} : { additionalProperties: false }),
    },
  };
}

const TRIGGERS: Record<string, [Record<string, S>, string[]?, boolean?]> = {
  state: [{ entity_id: entityIds, from: { type: ['string', 'null', 'array'] }, to: { type: ['string', 'null', 'array'] }, not_from: { type: ['string', 'array'] }, not_to: { type: ['string', 'array'] }, for: duration, attribute: string }, ['entity_id']],
  numeric_state: [{ entity_id: entityIds, above: numOrTemplate, below: numOrTemplate, value_template: string, attribute: string, for: duration }, ['entity_id']],
  time: [{ at: { type: ['string', 'array', 'object'] }, weekday: strOrList }, ['at']],
  time_pattern: [{ hours: scalar, minutes: scalar, seconds: scalar }],
  event: [{ event_type: strOrList, event_data: { type: 'object' }, context: { type: 'object' } }, ['event_type']],
  homeassistant: [{ event: { enum: ['start', 'shutdown'] } }, ['event']],
  mqtt: [{ topic: string, payload: scalar, value_template: string, encoding: string, qos: { type: ['integer', 'string'] } }, ['topic']],
  sun: [{ event: { enum: ['sunrise', 'sunset'] }, offset: { type: ['string', 'number'] } }, ['event']],
  template: [{ value_template: string, for: duration }, ['value_template']],
  webhook: [{ webhook_id: string, allowed_methods: { type: 'array', items: { enum: ['POST', 'PUT', 'GET', 'HEAD'] } }, local_only: bool }, ['webhook_id']],
  zone: [{ entity_id: entityIds, zone: string, event: { enum: ['enter', 'leave'] } }, ['entity_id', 'zone', 'event']],
  tag: [{ tag_id: strOrList, device_id: strOrList }, ['tag_id']],
  calendar: [{ event: { enum: ['start', 'end'] }, entity_id: string, offset: string }, ['entity_id']],
  conversation: [{ command: strOrList }, ['command']],
  geo_location: [{ source: string, zone: string, event: { enum: ['enter', 'leave'] } }, ['source', 'zone', 'event']],
  persistent_notification: [{ notification_id: string, update_type: strOrList }],
  device: [{ device_id: string, domain: string, type: string, entity_id: string, subtype: string, discovery_id: string }, ['device_id', 'domain', 'type'], true],
};

const CONDITIONS: Record<string, [Record<string, S>, string[]?, boolean?]> = {
  state: [{ entity_id: entityIds, state: { type: ['string', 'array', 'number', 'boolean'] }, for: duration, attribute: string, match_all: bool }, ['entity_id', 'state']],
  numeric_state: [{ entity_id: entityIds, above: numOrTemplate, below: numOrTemplate, value_template: string, attribute: string }, ['entity_id']],
  template: [{ value_template: string }, ['value_template']],
  time: [{ after: { type: ['string', 'number'] }, before: { type: ['string', 'number'] }, weekday: strOrList }],
  sun: [{ after: { enum: ['sunrise', 'sunset'] }, before: { enum: ['sunrise', 'sunset'] }, after_offset: { type: ['string', 'number'] }, before_offset: { type: ['string', 'number'] } }],
  zone: [{ entity_id: entityIds, zone: strOrList }, ['entity_id', 'zone']],
  trigger: [{ id: strOrList }, ['id']],
  and: [{ conditions: { type: 'array', items: { $ref: '#/$defs/condition' } } }, ['conditions']],
  or: [{ conditions: { type: 'array', items: { $ref: '#/$defs/condition' } } }, ['conditions']],
  not: [{ conditions: { type: 'array', items: { $ref: '#/$defs/condition' } } }, ['conditions']],
  device: [{ device_id: string, domain: string, type: string, entity_id: string, subtype: string }, ['device_id', 'domain', 'type'], true],
};

const ACTION_KEYS: Record<string, S> = {
  alias: string,
  enabled: bool,
  continue_on_error: bool,
  action: string,
  service: string,
  service_template: string,
  data: { type: 'object' },
  data_template: { type: 'object' },
  target,
  entity_id: entityIds,
  response_variable: string,
  metadata: { type: 'object' },
  delay: { type: ['string', 'number', 'object'] },
  wait_template: string,
  wait_for_trigger: { type: ['array', 'object'] },
  timeout: duration,
  continue_on_timeout: bool,
  choose: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        alias: string,
        conditions: { $ref: '#/$defs/conditions' },
        sequence: { $ref: '#/$defs/actions' },
      },
      required: ['conditions', 'sequence'],
      additionalProperties: false,
    },
  },
  default: { $ref: '#/$defs/actions' },
  if: { $ref: '#/$defs/conditions' },
  then: { $ref: '#/$defs/actions' },
  else: { $ref: '#/$defs/actions' },
  repeat: {
    type: 'object',
    properties: {
      count: numOrTemplate,
      while: { $ref: '#/$defs/conditions' },
      until: { $ref: '#/$defs/conditions' },
      for_each: { type: ['array', 'string', 'object'] },
      sequence: { $ref: '#/$defs/actions' },
    },
    required: ['sequence'],
    additionalProperties: false,
  },
  parallel: { $ref: '#/$defs/actions' },
  sequence: { $ref: '#/$defs/actions' },
  variables: { type: 'object' },
  stop: string,
  error: bool,
  event: string,
  event_data: { type: 'object' },
  event_data_template: { type: 'object' },
  scene: string,
  device_id: string,
  domain: string,
  type: string,
  subtype: string,
  condition: string,
  // shorthand conditions allowed as an action
  state: { type: ['string', 'array', 'number', 'boolean'] },
  above: numOrTemplate,
  below: numOrTemplate,
  value_template: string,
  conditions: { type: 'array' },
  zone: strOrList,
  after: { type: ['string', 'number'] },
  before: { type: ['string', 'number'] },
  weekday: strOrList,
  attribute: string,
  for: duration,
  id: strOrList,
};

/** `x` or a list of `x`, without the noisy errors a oneOf would produce. */
const listOrOne = (ref: string): S => ({
  type: ['object', 'array', 'string'],
  if: { type: 'array' },
  then: { items: { $ref: ref } },
  else: { $ref: ref },
});

const mode = { enum: ['single', 'restart', 'queued', 'parallel'] };

const defs: Record<string, S> = {
  trigger: {
    type: 'object',
    properties: { platform: { enum: Object.keys(TRIGGERS) }, trigger: { enum: [...Object.keys(TRIGGERS), 'state'] } },
    allOf: [
      {
        if: { not: { anyOf: [{ required: ['platform'] }, { required: ['trigger'] }] } },
        then: { required: ['platform'] },
      },
      ...Object.entries(TRIGGERS).flatMap(([name, [props, req, open]]) => [
        variant('platform', name, props, req, open),
        variant('trigger', name, props, req, open),
      ]),
    ],
  },
  triggers: listOrOne('#/$defs/trigger'),
  condition: {
    type: ['object', 'string'],
    properties: { condition: { enum: Object.keys(CONDITIONS) } },
    allOf: [
      {
        if: { type: 'object', not: { anyOf: ['condition', 'and', 'or', 'not'].map((k) => ({ required: [k] })) } },
        then: { required: ['condition'] },
      },
      ...Object.entries(CONDITIONS).map(([name, [props, req, open]]) => variant('condition', name, props, req, open)),
    ],
  },
  conditions: listOrOne('#/$defs/condition'),
  action: { type: 'object', properties: ACTION_KEYS, additionalProperties: false },
  actions: listOrOne('#/$defs/action'),
};

const automation: S = {
  type: 'object',
  properties: {
    id: string,
    alias: string,
    description: string,
    mode,
    max: { type: 'integer', minimum: 1 },
    max_exceeded: { enum: ['silent', 'critical', 'fatal', 'error', 'warning', 'info', 'debug'] },
    trigger: { $ref: '#/$defs/triggers' },
    triggers: { $ref: '#/$defs/triggers' },
    condition: { $ref: '#/$defs/conditions' },
    conditions: { $ref: '#/$defs/conditions' },
    action: { $ref: '#/$defs/actions' },
    actions: { $ref: '#/$defs/actions' },
    variables: { type: 'object' },
    trigger_variables: { type: 'object' },
    initial_state: bool,
    hide_entity: bool,
    trace: { type: 'object', properties: { stored_traces: { type: 'integer' } } },
    use_blueprint: { type: 'object' },
  },
  additionalProperties: false,
  anyOf: [{ required: ['action'] }, { required: ['actions'] }, { required: ['use_blueprint'] }],
};

const script: S = {
  type: 'object',
  properties: {
    alias: string,
    description: string,
    icon: string,
    mode,
    max: { type: 'integer', minimum: 1 },
    max_exceeded: { enum: ['silent', 'critical', 'fatal', 'error', 'warning', 'info', 'debug'] },
    sequence: { $ref: '#/$defs/actions' },
    fields: { type: 'object' },
    variables: { type: 'object' },
    trace: { type: 'object' },
    use_blueprint: { type: 'object' },
  },
  additionalProperties: false,
};

const scene: S = {
  type: 'object',
  properties: {
    id: string,
    name: string,
    icon: string,
    entities: { type: 'object' },
    metadata: { type: 'object' },
  },
  required: ['name'],
  additionalProperties: false,
};

const withDefs = (s: S): S => ({ $schema: 'https://json-schema.org/draft/2020-12/schema', ...s, $defs: defs });

export const automationsFile = withDefs({ type: 'array', items: automation });
export const scriptsFile = withDefs({ type: 'object', additionalProperties: script });
export const scenesFile = withDefs({ type: 'array', items: scene });

const logLevel = { enum: ['notset', 'debug', 'info', 'warning', 'warn', 'error', 'fatal', 'critical'] };

const integrations: Record<string, S> = {
  homeassistant: {
    type: 'object',
    properties: {
      name: string,
      latitude: numOrTemplate,
      longitude: numOrTemplate,
      elevation: numOrTemplate,
      unit_system: { enum: ['metric', 'imperial', 'us_customary', 'si'] },
      currency: string,
      time_zone: string,
      country: string,
      language: string,
      external_url: string,
      internal_url: string,
      customize: { type: 'object' },
      customize_domain: { type: 'object' },
      customize_glob: { type: 'object' },
      packages: { type: ['object', 'string'] },
      allowlist_external_dirs: { type: 'array', items: string },
      allowlist_external_urls: { type: 'array', items: string },
      media_dirs: { type: 'object' },
      auth_providers: { type: 'array' },
      legacy_templates: bool,
      debug: bool,
    },
    additionalProperties: false,
  },
  automation: { type: ['string', 'array'], items: automation },
  script: { type: ['string', 'object'], additionalProperties: script },
  scene: { type: ['string', 'array'], items: scene },
  logger: {
    type: 'object',
    properties: { default: logLevel, logs: { type: 'object', additionalProperties: logLevel }, filters: { type: 'object' } },
    additionalProperties: false,
  },
  http: {
    type: 'object',
    properties: {
      server_port: { type: 'integer', minimum: 1, maximum: 65535 },
      server_host: { type: ['string', 'array'] },
      ssl_certificate: string,
      ssl_key: string,
      use_x_forwarded_for: bool,
      trusted_proxies: { type: 'array', items: string },
      cors_allowed_origins: { type: 'array', items: string },
      ip_ban_enabled: bool,
      login_attempts_threshold: { type: 'integer' },
    },
    additionalProperties: false,
  },
  recorder: {
    type: 'object',
    properties: {
      db_url: string,
      purge_keep_days: { type: 'integer', minimum: 1 },
      auto_purge: bool,
      auto_repack: bool,
      commit_interval: { type: 'integer', minimum: 0 },
      include: { type: 'object' },
      exclude: { type: 'object' },
    },
    additionalProperties: false,
  },
};

export const configurationFile = withDefs({
  type: 'object',
  properties: integrations,
  // Every other key is an integration whose schema we do not know about.
  additionalProperties: true,
});
