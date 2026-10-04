#!/bin/bash
# Regenerate web/public/schemas from the latest Home Assistant release.
#   tools/schemagen/generate.sh [work_dir]
# Needs `uv` (pip install uv). Takes a few minutes: it installs Home Assistant and the libraries
# of every YAML-configurable integration so they can be imported.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${1:-/tmp/schemagen}
OUT="$HERE/../../web/public/schemas"
mkdir -p "$WORK" "$OUT/integrations"
cd "$WORK"
[ -d venv ] || uv venv --python 3.13 venv
uv pip install -q --python venv/bin/python homeassistant voluptuous-openapi "setuptools<81"
venv/bin/python "$HERE/requirements_for_yaml.py" > reqs.txt
: > failed.txt
install_one() {
  r="$1"
  uv pip install -q --python venv/bin/python --only-binary :all: "$r" >/dev/null 2>&1 && return 0
  n=$(echo "$r" | sed -E 's/[=<>!~;\[ ].*//')
  uv pip install -q --python venv/bin/python --only-binary :all: "$n" >/dev/null 2>&1 && return 0
  timeout 100 uv pip install -q --python venv/bin/python "$n" >/dev/null 2>&1 || echo "$r" >> failed.txt
}
while read -r r; do
  install_one "$r" &
  while [ "$(jobs -r | wc -l)" -ge 6 ]; do sleep 0.2; done
done < reqs.txt
wait
venv/bin/python "$HERE/gen.py" gen_out
cp gen_out/index.json "$OUT/index.json"
cp gen_out/integrations/*.json "$OUT/integrations/"
cp gen_out/failures.json "$HERE/failures.json"
echo "schemas written to $OUT (remove stale files in integrations/ first if an integration was dropped)"
