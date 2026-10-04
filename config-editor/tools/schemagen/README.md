# schemagen

Generates the integration schemas the editor uses for `configuration.yaml` (`web/public/schemas`).

Home Assistant validates YAML with [voluptuous](https://github.com/alecthomas/voluptuous) schemas
(`CONFIG_SCHEMA` / `PLATFORM_SCHEMA`) in every integration. `convert.py` translates those to JSON Schema,
`gen.py` walks all integrations and writes one file per `configuration.yaml` key:

* `integrations/<domain>.json` → `{ "schema": …, "defs": … }`
  * normal integrations: the schema of the `<domain>:` key
  * entity-platform domains (`sensor`, `notify`, `light`, …): a list of entries, each one validated by the
    schema of its `platform:` (one `$defs` variant per platform integration)
* `index.json` → domain names, kinds, docs links and the Home Assistant version they were generated from.

Run `./generate.sh` to refresh them for a new Home Assistant release (a few minutes).

## Fidelity

HA validators are arbitrary Python, so the conversion is best effort and **permissive**: anything that cannot
be described statically (custom `validate()` functions, cross-key checks, config-flow-only integrations) is left
unconstrained instead of risking false errors. Enums, ranges, required keys, key names and nesting are exact.
`failures.json` lists the integrations that could not be imported (obscure hardware libraries without wheels).

`automation`, `script` and `scene` are not generated: HA validates triggers, conditions and actions dynamically,
so the editor ships hand-written schemas for them.
