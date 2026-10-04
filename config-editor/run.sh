#!/usr/bin/with-contenv sh
# with-contenv exposes the add-on environment (SUPERVISOR_TOKEN, ...) to the process.
cd /app/server
export ADDON=1
exec node dist/index.js
