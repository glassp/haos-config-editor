// Tiny fake Home Assistant API for local development: node dev/mock-ha.mjs
import http from 'node:http';

const states = [
  ['light.kitchen', 'Kitchen Light', 'on'],
  ['light.living_room', 'Living Room Light', 'off'],
  ['sensor.outdoor_temperature', 'Outdoor Temperature', '12.4'],
  ['binary_sensor.front_door', 'Front Door', 'off'],
  ['switch.coffee_machine', 'Coffee Machine', 'off'],
  ['climate.hallway', 'Hallway Thermostat', 'heat'],
  ['person.alex', 'Alex', 'home'],
].map(([entity_id, friendly_name, state]) => ({ entity_id, state, attributes: { friendly_name } }));

const services = [
  { domain: 'light', services: { turn_on: { name: 'Turn on', description: 'Turn on one or more lights.', fields: { brightness_pct: { name: 'Brightness', description: 'Percentage brightness.' }, transition: { name: 'Transition' }, color_name: { name: 'Color name' }, advanced_fields: { fields: { effect: { name: 'Effect' } } } } }, turn_off: { name: 'Turn off', fields: { transition: {} } }, toggle: { name: 'Toggle', fields: {} } } },
  { domain: 'switch', services: { turn_on: { name: 'Turn on', fields: {} }, turn_off: { name: 'Turn off', fields: {} } } },
  { domain: 'notify', services: { notify: { name: 'Send notification', fields: { message: { name: 'Message' }, title: { name: 'Title' } } } } },
  { domain: 'automation', services: { reload: { name: 'Reload', fields: {} } } },
];

const components = ['homeassistant', 'automation', 'script', 'scene', 'light', 'switch', 'sensor', 'binary_sensor', 'mqtt', 'recorder', 'logger', 'http'];

http
  .createServer((req, res) => {
    const send = (o) => (res.setHeader('content-type', 'application/json'), res.end(JSON.stringify(o)));
    if (req.url === '/api/states') return send(states);
    if (req.url === '/api/services') return send(services);
    if (req.url === '/api/config') return send({ components });
    if (req.url === '/api/config/core/check_config') return send({ result: 'valid', errors: null });
    if (req.method === 'POST' && req.url.startsWith('/api/services/')) return send([]);
    res.statusCode = 404;
    send({ message: 'not found' });
  })
  .listen(8123, '127.0.0.1', () => console.log('mock HA on :8123'));
