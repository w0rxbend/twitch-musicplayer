#!/bin/sh
# Writes the runtime backend configuration read by index.html and admin.html.
#
# Vite inlines VITE_* variables at build time, so a published image would
# otherwise be permanently pinned to whatever backend URL it was built against.
# Generating this file at container start lets one image serve any deployment.
#
# BACKEND_URL unset or empty is the normal case: the page then falls back to the
# host that served it on port 8080, which is what the Compose layout provides.
set -eu

target="/usr/share/nginx/html/config.js"
backend_url="${BACKEND_URL:-}"

if [ -n "$backend_url" ]; then
    # Escape backslashes then double quotes, so a stray character cannot break
    # out of the JavaScript string literal.
    escaped=$(printf '%s' "$backend_url" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
    printf 'window.__LOFI_CONFIG__ = { backendUrl: "%s" };\n' "$escaped" > "$target"
    echo "lofi-config: backend URL set to $backend_url"
else
    printf 'window.__LOFI_CONFIG__ = {};\n' > "$target"
    echo "lofi-config: no BACKEND_URL set, falling back to <page host>:8080"
fi
