"""Print the third-party requirements of every integration that has a YAML schema (plus its dependencies).

The generator imports each integration, which needs these libraries to be installed.
"""
import json
import pathlib

import homeassistant.components as c

base = pathlib.Path(c.__path__[0])
manifests = {d.name: json.loads((d / "manifest.json").read_text()) for d in base.iterdir() if d.is_dir() and (d / "manifest.json").exists()}


def has_yaml_schema(domain: str) -> bool:
    return any("CONFIG_SCHEMA" in t or "PLATFORM_SCHEMA" in t for t in (f.read_text(errors="ignore") for f in (base / domain).rglob("*.py")))


relevant = {d for d in manifests if has_yaml_schema(d)}
todo = list(relevant)
while todo:
    d = todo.pop()
    for dep in manifests[d].get("dependencies", []) + manifests[d].get("after_dependencies", []):
        if dep in manifests and dep not in relevant:
            relevant.add(dep)
            todo.append(dep)

SKIP = ("tensorflow", "pycoral", "opencv", "torch", "pytorch", "pyaudio", "pybluez", "bluepy", "pygatt")  # huge or need system libs
for r in sorted({r for d in relevant for r in manifests[d].get("requirements", []) if not r.lower().startswith(SKIP)}):
    print(r)
