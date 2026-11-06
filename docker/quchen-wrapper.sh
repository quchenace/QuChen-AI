#!/bin/sh
# `quchen` inside the container: the Terminal, with the address and the API key of the server this container runs, so that
# `docker exec <name> quchen monitor --once`, `quchen status` and `quchen connect opencode` work without typing either.
# A key or address you set yourself (QUCHEN_API_KEY, QUCHEN_URL, --url) always wins.
KEY_FILE="${QUCHEN_KEY_FILE:-/data/state/api-key}"
if [ -z "${QUCHEN_API_KEY:-}" ] && [ -r "$KEY_FILE" ]; then
  QUCHEN_API_KEY=$(cat "$KEY_FILE"); export QUCHEN_API_KEY
fi
QUCHEN_URL="${QUCHEN_URL:-http://127.0.0.1:${PORT:-8080}}"; export QUCHEN_URL
exec /opt/quchen/terminal/bin/quchen "$@"
