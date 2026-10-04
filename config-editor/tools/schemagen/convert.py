"""Convert Home Assistant's voluptuous validation schemas to JSON Schema.

HA's validators are arbitrary Python callables, so the conversion is best effort and errs on the
permissive side: anything that cannot be described becomes `{}` (accept anything). A false
"error" in the editor is worse than a missed one.
"""
from __future__ import annotations

import enum
import re
from typing import Any

import voluptuous as vol
from homeassistant.helpers import config_validation as cv

SCALAR = ["string", "number", "boolean"]  # cv.string and friends coerce these


def _identity_table() -> dict[int, dict[str, Any]]:
    t: dict[Any, dict[str, Any]] = {}

    def put(name: str, schema: dict[str, Any]) -> None:
        fn = getattr(cv, name, None)
        if fn is not None:
            t[id(fn)] = schema

    for fn in (vol.Email, vol.Url, vol.FqdnUrl, vol.IsFile, vol.IsDir, vol.PathExists):
        t[id(fn)] = {"type": "string"}
    t[id(vol.Boolean)] = {"type": ["boolean", "string", "integer"]}

    put("string", {"type": SCALAR})
    put("boolean", {"type": ["boolean", "string", "integer"]})
    put("positive_int", {"type": ["integer", "string"], "minimum": 0})
    put("positive_float", {"type": ["number", "string"], "minimum": 0})
    put("small_float", {"type": ["number", "string"], "minimum": 0, "maximum": 1})
    put("byte", {"type": ["integer", "string"], "minimum": 0, "maximum": 255})
    put("port", {"type": ["integer", "string"], "minimum": 1, "maximum": 65535})
    put("socket_timeout", {"type": "number"})
    put("positive_timedelta", {"type": ["string", "number", "object"]})
    put("time_period", {"type": ["string", "number", "object"]})
    put("time_period_str", {"type": "string"})
    put("time_period_seconds", {"type": ["number", "string"]})
    put("positive_time_period", {"type": ["string", "number", "object"]})
    put("positive_time_period_dict", {"type": ["object", "string", "number"]})
    put("time", {"type": "string"})
    put("date", {"type": "string"})
    put("datetime", {"type": "string"})
    put("entity_id", {"type": "string", "pattern": r"^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$"})
    put("entity_ids", {"type": ["string", "array"], "items": {"type": "string"}})
    put("entity_id_or_uuid", {"type": "string"})
    put("comp_entity_ids", {"type": ["string", "array"], "items": {"type": "string"}})
    put("slug", {"type": "string"})
    put("slugify", {"type": "string"})
    put("icon", {"type": "string"})
    put("url", {"type": "string"})
    put("url_no_path", {"type": "string"})
    put("temperature_unit", {"enum": ["C", "F"]})
    put("service", {"type": "string"})
    put("template", {"type": SCALAR})
    put("template_complex", {})
    put("match_all", {})
    put("ensure_list_csv", {"type": ["string", "array"]})
    put("ensure_list", {"type": "array"})
    put("path", {"type": "string"})
    put("isdir", {"type": "string"})
    put("isfile", {"type": "string"})
    put("ssl_cipher_list", {"type": "string"})
    put("string_with_no_html", {"type": "string"})
    put("whitespace", {"type": "string"})
    put("x10_address", {"type": "string"})
    put("matches_regex", {"type": "string"})
    put("uuid4_hex", {"type": "string"})
    put("country", {"type": "string"})
    put("language", {"type": "string"})
    put("currency", {"type": "string"})
    put("time_zone", {"type": "string"})
    put("temperature_unit", {"enum": ["C", "F"]})
    put("script_action", {"type": "object"})
    return t


KNOWN = _identity_table()
ENSURE_LIST = id(cv.ensure_list)
CASE_FUNCS = {id(f) for f in (vol.Upper, vol.Lower, vol.Capitalize, vol.Title)}
# vol types / helpers
PY_TYPES = {str: {"type": "string"}, int: {"type": "integer"}, float: {"type": "number"}, bool: {"type": "boolean"}, dict: {"type": "object"}, list: {"type": "array"}}


class Ctx:
    def __init__(self, ns: str) -> None:
        self.ns = ns
        self.defs: dict[str, Any] = {}
        self.depth = 0
        self.extra: Any = vol.PREVENT_EXTRA


def _simplify_any(branches: list[dict[str, Any]]) -> dict[str, Any]:
    branches = [b for b in branches if b is not None]
    if any(b == {} for b in branches):
        return {}
    # `Any(X, None)` is just a nullable X
    nulls = [b for b in branches if b == {"type": "null"}]
    others = [b for b in branches if b != {"type": "null"}]
    if nulls and len(others) == 1:
        o = others[0]
        return {**o, "type": _merge_types(o.get("type"), "null")} if o.get("type") is not None else {}
    # merge plain type unions: [{type: a}, {type: b}] -> {type: [a, b]}
    if all(set(b) <= {"type"} for b in branches):
        types: list[str] = []
        for b in branches:
            for t in b["type"] if isinstance(b["type"], list) else [b["type"]]:
                if t not in types:
                    types.append(t)
        return {"type": types}
    # merge enums / consts: Any("a", "b", In([...]))
    if all(set(b) in ({"enum"}, {"const"}) for b in branches):
        vals: list[Any] = []
        for b in branches:
            for v in b["enum"] if "enum" in b else [b["const"]]:
                if v not in vals:
                    vals.append(v)
        return {"enum": vals}
    uniq: list[dict[str, Any]] = []
    for b in branches:
        if b not in uniq:
            uniq.append(b)
    return uniq[0] if len(uniq) == 1 else {"anyOf": uniq}


def _list_or_one(item: dict[str, Any]) -> dict[str, Any]:
    # one item or a list of items; `if` keeps validation errors specific
    if not item:
        return {}
    types = item.get("type")
    out: dict[str, Any] = {"if": {"type": "array"}, "then": {"items": item}, "else": item}
    if types is not None:
        out["type"] = _merge_types(types, "array")
    return out


def _merge_types(types: Any, extra: str) -> Any:
    if types is None:
        return None
    ts = types if isinstance(types, list) else [types]
    return ts if extra in ts else [*ts, extra]


def _literal(value: Any) -> dict[str, Any]:
    if isinstance(value, enum.Enum):
        value = value.value
    if value is None or isinstance(value, (str, int, float, bool)):
        return {"const": value}
    return {}


def convert(schema: Any, ctx: Ctx) -> dict[str, Any]:
    ctx.depth += 1
    try:
        if ctx.depth > 40:
            return {}
        return _convert(schema, ctx)
    except Exception:  # never let one odd validator break a whole integration
        return {}
    finally:
        ctx.depth -= 1


def _convert(schema: Any, ctx: Ctx) -> dict[str, Any]:  # noqa: C901 - one big dispatcher
    if schema is None:
        return {"type": "null"}
    if id(schema) in KNOWN:
        return dict(KNOWN[id(schema)])
    if schema in PY_TYPES if isinstance(schema, type) else False:
        return dict(PY_TYPES[schema])

    if isinstance(schema, vol.Schema):
        # `extra` is inherited by plain nested dicts but not by nested vol.Schema objects.
        saved, ctx.extra = ctx.extra, schema.extra
        try:
            return convert(schema.schema, ctx)
        finally:
            ctx.extra = saved

    if isinstance(schema, dict):
        return _object(schema, ctx)

    if isinstance(schema, (list, tuple, set, frozenset)):
        items = [convert(x, ctx) for x in schema]
        out: dict[str, Any] = {"type": "array"}
        if items:
            out["items"] = _simplify_any(items)
        return out

    if isinstance(schema, vol.Coerce):
        t = schema.type
        if t in (int, float):
            return {"type": ["number", "string"]}  # "80" is coerced to 80
        if t in PY_TYPES:
            return dict(PY_TYPES[t])
        if isinstance(t, type) and issubclass(t, enum.Enum):
            return {"enum": [m.value for m in t]}
        return {}
    if isinstance(schema, vol.In):
        c = schema.container
        try:
            vals = list(c.keys()) if isinstance(c, dict) else list(c)
        except Exception:
            return {}
        vals = [v.value if isinstance(v, enum.Enum) else v for v in vals]
        vals = [v for v in vals if v is None or isinstance(v, (str, int, float, bool))]
        return {"enum": vals} if vals else {}
    if isinstance(schema, vol.Range):
        out: dict[str, Any] = {}
        if schema.min is not None:
            out["minimum" if schema.min_included else "exclusiveMinimum"] = schema.min
        if schema.max is not None:
            out["maximum" if schema.max_included else "exclusiveMaximum"] = schema.max
        return out
    if isinstance(schema, vol.Length):
        out = {}
        if schema.min is not None:
            out.update(minLength=schema.min, minItems=schema.min)
        if schema.max is not None:
            out.update(maxLength=schema.max, maxItems=schema.max)
        return out
    if isinstance(schema, vol.Match):
        pat = schema.pattern.pattern if hasattr(schema.pattern, "pattern") else str(schema.pattern)
        return {"type": "string", "pattern": pat}
    if isinstance(schema, vol.Any):
        return _simplify_any([convert(v, ctx) for v in schema.validators])
    if isinstance(schema, vol.All):
        return _all(schema.validators, ctx)
    if isinstance(schema, (vol.Marker,)):
        return convert(schema.schema, ctx)
    if isinstance(schema, (str, int, float, bool, enum.Enum)):
        return _literal(schema)
    if callable(schema):
        return _callable(schema, ctx)
    return {}


def _closure(fn: Any) -> dict[str, Any]:
    names = getattr(getattr(fn, "__code__", None), "co_freevars", ())
    cells = getattr(fn, "__closure__", None) or ()
    out: dict[str, Any] = {}
    for n, c in zip(names, cells):
        try:
            out[n] = c.cell_contents
        except ValueError:
            pass
    return out


def _callable(fn: Any, ctx: Ctx) -> dict[str, Any]:
    """Validators built by cv helper factories keep their arguments in a closure."""
    q = getattr(fn, "__qualname__", "")
    cl = _closure(fn)
    if q.startswith("schema_with_slug_keys.") and "schema" in cl:
        inner = convert(cl["schema"], ctx)  # vol.Schema({str: value_schema})
        return {"type": "object", "additionalProperties": inner.get("additionalProperties", True)}
    if q.startswith("key_value_schemas.") and "value_schemas" in cl and "key" in cl:
        key = str(cl["key"])
        variants = []
        for value, sub in cl["value_schemas"].items():
            if isinstance(value, enum.Enum):
                value = value.value
            if not isinstance(value, (str, int, float, bool)):
                continue
            variants.append({"if": {"properties": {key: {"const": value}}, "required": [key]}, "then": convert(sub, ctx)})
        out = {"type": "object", "properties": {key: {"examples": [v["if"]["properties"][key]["const"] for v in variants]}}, "allOf": variants}
        default = cl.get("default_schema")
        if default is not None:
            out.update({k: v for k, v in convert(default, ctx).items() if k not in out})
        return out
    if q.startswith(("entity_domain.", "entities_domain.")):
        return {"type": ["string", "array"]}
    try:  # Home Assistant knows how to describe many of its own validators
        import voluptuous_openapi

        res = voluptuous_openapi.convert(fn, custom_serializer=cv.custom_serializer)
        res.pop("description", None)
        return res if isinstance(res, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def _all(validators: list[Any], ctx: Ctx) -> dict[str, Any]:
    wrap_list = False
    normalises_case = False
    parts: list[dict[str, Any]] = []
    for v in validators:
        if id(v) == ENSURE_LIST:
            wrap_list = True
            continue
        if id(v) in CASE_FUNCS:
            normalises_case = True  # e.g. vol.Upper runs before vol.In, so any casing is accepted
            continue
        if id(v) in KNOWN and KNOWN[id(v)] == {} :
            continue
        part = convert(v, ctx)
        if part:
            parts.append(part)
    merged = _merge_all(parts)
    if normalises_case and isinstance(merged.get("enum"), list):
        merged = {**merged, "x-case-insensitive": True}  # the editor compares ignoring case
    if not wrap_list:
        return merged
    # cv.ensure_list wraps a lone value into a list first, so `All(ensure_list, [X])` accepts X or [X]
    if merged.get("type") == "array" or ("items" in merged and "type" not in merged):
        return _list_or_one(merged.get("items", {}))
    return _list_or_one(merged)


def _merge_all(parts: list[dict[str, Any]]) -> dict[str, Any]:
    if not parts:
        return {}
    if len(parts) == 1:
        return parts[0]
    # prefer the structural schema (object/array) and fold simple constraints into it
    structural = [p for p in parts if "properties" in p or "additionalProperties" in p or "items" in p or "anyOf" in p or "if" in p]
    base = dict(structural[0] if structural else parts[0])
    for p in parts:
        if p is (structural[0] if structural else parts[0]):
            continue
        for k, v in p.items():
            if k not in base:
                base[k] = v
            elif k == "type" and base[k] != v:
                # intersect types when possible, otherwise keep the narrower (first)
                a = base[k] if isinstance(base[k], list) else [base[k]]
                b = v if isinstance(v, list) else [v]
                common = [t for t in a if t in b or (t == "integer" and "number" in b)]
                base[k] = common[0] if len(common) == 1 else (common or a)
    return base


def _object(d: dict[Any, Any], ctx: Ctx) -> dict[str, Any]:
    props: dict[str, Any] = {}
    required: list[str] = []
    additional: Any = None
    patterns: dict[str, Any] = {}
    for key, val in d.items():
        marker = key if isinstance(key, vol.Marker) else None
        if isinstance(marker, vol.Remove):
            continue
        k = key.schema if marker else key
        if isinstance(k, (str, int, float, bool, enum.Enum)):
            name = str(k.value if isinstance(k, enum.Enum) else k)
            sub = convert(val, ctx)
            if marker is not None and getattr(marker, "description", None):
                sub = {**sub, "description": str(marker.description)}
            if isinstance(marker, vol.Optional) or marker is not None:
                default = getattr(marker, "default", vol.UNDEFINED)
                if default is not vol.UNDEFINED and not callable(default):
                    if isinstance(default, (str, int, float, bool)) or default is None:
                        sub = {**sub, "default": default}
            props[name] = sub
            if isinstance(marker, vol.Required):
                required.append(name)
        else:
            # key is a type or validator: any key of that shape
            sub = convert(val, ctx)
            if isinstance(k, vol.Match):
                pat = k.pattern.pattern if hasattr(k.pattern, "pattern") else str(k.pattern)
                patterns[pat] = sub
            else:
                additional = sub if additional is None else _simplify_any([additional, sub])
    out: dict[str, Any] = {"type": "object"}
    if props:
        out["properties"] = props
    if required:
        out["required"] = required
    if patterns:
        out["patternProperties"] = patterns
    if additional is not None:
        out["additionalProperties"] = additional or True
    elif props or required:
        # voluptuous rejects unknown keys unless the schema was built with ALLOW_EXTRA/REMOVE_EXTRA
        out["additionalProperties"] = ctx.extra != vol.PREVENT_EXTRA
    return out


def to_schema(validator: Any, ns: str) -> dict[str, Any]:
    return convert(validator, Ctx(ns))
