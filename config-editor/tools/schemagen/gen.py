"""Generate JSON Schemas for configuration.yaml from the installed Home Assistant.

Usage:  python gen.py <out_dir>

Requires `homeassistant` (see README.md). For every integration it reads
  * CONFIG_SCHEMA  of homeassistant.components.<domain>           -> schema of the `<domain>:` key
  * PLATFORM_SCHEMA of homeassistant.components.<domain>          -> entity-platform domains (sensor, notify, ...)
    and of every homeassistant.components.<platform>.<domain>      -> one variant per `platform: <platform>`
and writes one file per domain plus an index.
"""
from __future__ import annotations

import importlib
import json
import pathlib
import sys
import traceback
from typing import Any

import voluptuous as vol
from homeassistant.helpers import config_validation as cv

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from convert import to_schema  # noqa: E402

import homeassistant.components as components_pkg  # noqa: E402
from homeassistant.const import __version__ as HA_VERSION  # noqa: E402

BASE = pathlib.Path(components_pkg.__path__[0])
# Hand-written schemas in the editor are better for these (triggers/conditions/actions are validated
# dynamically by HA, so no static voluptuous schema exists).
SKIP_DOMAINS = {"automation", "script", "scene"}


def try_import(name: str):
    try:
        return importlib.import_module(name)
    except BaseException as e:  # noqa: BLE001  (ImportError, SystemExit from odd modules, ...)
        return e


# Integrations that validate through async_validate_config() instead of a module level CONFIG_SCHEMA:
# domain -> (module, attribute holding the schema of ONE entry, YAML value is a list of entries)
SPECIAL = {
    "template": ("homeassistant.components.template.config", "CONFIG_SECTION_SCHEMA", True),
}


def special_schema(domain: str) -> dict[str, Any] | None:
    module, attr, as_list = SPECIAL[domain]
    mod = try_import(module)
    if isinstance(mod, BaseException) or not hasattr(mod, attr):
        return None
    from convert import _list_or_one  # noqa: PLC0415

    entry = to_schema(getattr(mod, attr), domain)
    return _list_or_one(entry) if as_list else entry


def extract_domain_schema(domain: str, mod: Any) -> dict[str, Any] | None:
    if domain in SPECIAL:
        return special_schema(domain)
    cs = getattr(mod, "CONFIG_SCHEMA", None)
    if cs is None:
        return None
    full = to_schema(cs, domain)
    props = full.get("properties", {}) if isinstance(full, dict) else {}
    inner = props.get(domain)
    if inner is None and "anyOf" in full:
        return None
    return inner


def platform_entry_schema(mod: Any, domain: str) -> dict[str, Any] | None:
    ps = getattr(mod, "PLATFORM_SCHEMA", None)
    if ps is None:
        return None
    return to_schema(ps, domain)


def main(out: pathlib.Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    (out / "integrations").mkdir(exist_ok=True)
    manifests: dict[str, dict[str, Any]] = {}
    for d in sorted(BASE.iterdir()):
        mf = d / "manifest.json"
        if d.is_dir() and mf.exists():
            manifests[d.name] = json.loads(mf.read_text())

    # --- which integrations act as platforms for which domain -------------------------------
    platform_files: dict[str, list[str]] = {}  # domain -> [platform integration names]
    for name in manifests:
        for f in (BASE / name).iterdir():
            stem = f.stem if f.suffix == ".py" else f.name if f.is_dir() and (f / "__init__.py").exists() else None
            if stem and stem in manifests and stem != name and stem not in ("__init__",):
                if "PLATFORM_SCHEMA" in (f.read_text(errors="ignore") if f.suffix == ".py" else (f / "__init__.py").read_text(errors="ignore")):
                    platform_files.setdefault(stem, []).append(name)

    index: dict[str, Any] = {"haVersion": HA_VERSION, "domains": {}}
    failures: dict[str, str] = {}

    # core `homeassistant:` key
    try:
        try:
            from homeassistant.core_config import CORE_CONFIG_SCHEMA
        except ImportError:  # older Home Assistant
            from homeassistant.config import CORE_CONFIG_SCHEMA

        core = to_schema(CORE_CONFIG_SCHEMA, "homeassistant")
        write(out, "homeassistant", {"schema": core, "defs": {}}, index, manifests.get("homeassistant", {}), "config")
    except Exception as e:  # noqa: BLE001
        failures["homeassistant"] = repr(e)

    for domain, manifest in manifests.items():
        if domain in SKIP_DOMAINS or domain == "homeassistant":
            continue
        mod = try_import(f"homeassistant.components.{domain}")
        if isinstance(mod, BaseException):
            if domain in platform_files or True:
                failures[domain] = f"import: {type(mod).__name__}: {str(mod)[:120]}"
            continue

        defs: dict[str, Any] = {}
        schema: dict[str, Any] | None = None
        kind = "config"

        if getattr(mod, "PLATFORM_SCHEMA", None) is not None and domain in platform_files or getattr(mod, "PLATFORM_SCHEMA", None) is not None:
            kind = "platform"
            base = platform_entry_schema(mod, domain) or {"type": "object"}
            names: list[str] = []
            allof: list[dict[str, Any]] = []
            for p in sorted(platform_files.get(domain, [])):
                pm = try_import(f"homeassistant.components.{p}.{domain}")
                if isinstance(pm, BaseException):
                    failures[f"{domain}/{p}"] = f"import: {type(pm).__name__}: {str(pm)[:100]}"
                    names.append(p)
                    continue
                ps = platform_entry_schema(pm, domain)
                names.append(p)
                if not ps:
                    continue
                ref = f"{domain}__{p}"
                defs[ref] = ps
                allof.append({"if": {"properties": {"platform": {"const": p}}, "required": ["platform"]}, "then": {"$ref": f"#/$defs/{ref}"}})
            entry = dict(base)
            entry.setdefault("properties", {})
            entry["properties"]["platform"] = {"type": "string", "examples": names}
            entry.pop("required", None)  # platform presence is checked below
            entry["additionalProperties"] = True  # real constraints live in the per-platform variants
            entry["allOf"] = [
                {"if": {"not": {"required": ["platform"]}}, "then": {"required": ["platform"]}},
                *allof,
            ]
            defs[f"{domain}__entry"] = entry
            ref = {"$ref": f"#/$defs/{domain}__entry"}
            schema = {"type": ["array", "object"], "if": {"type": "array"}, "then": {"items": ref}, "else": ref}
        else:
            schema = extract_domain_schema(domain, mod)
            if schema is None:
                continue

        write(out, domain, {"schema": schema, "defs": defs}, index, manifest, kind, platforms=sorted(platform_files.get(domain, [])) if kind == "platform" else None)

    (out / "index.json").write_text(json.dumps(index, separators=(",", ":"), sort_keys=True))
    (out / "failures.json").write_text(json.dumps(failures, indent=1, sort_keys=True))
    print(f"HA {HA_VERSION}: {len(index['domains'])} domains written, {len(failures)} failures")


def write(out: pathlib.Path, domain: str, payload: dict[str, Any], index: dict[str, Any], manifest: dict[str, Any], kind: str, platforms: list[str] | None = None) -> None:
    text = json.dumps(payload, separators=(",", ":"), sort_keys=True, default=str)
    (out / "integrations" / f"{domain}.json").write_text(text)
    entry: dict[str, Any] = {"name": manifest.get("name", domain), "kind": kind}
    if manifest.get("documentation"):
        entry["doc"] = manifest["documentation"]
    if platforms:
        entry["platforms"] = len(platforms)
    index["domains"][domain] = entry


if __name__ == "__main__":
    main(pathlib.Path(sys.argv[1]))
