#!/usr/bin/env bash
# Restart the mixer server (and its supervisor) cleanly.
#   $(cd "$(dirname "$0")" && pwd)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
DATA="$HERE/data"
PORT=8484
SUP="$DATA/supervisor.pid"
SRV="$DATA/server.pid"
mkdir -p "$DATA"

readpid() { [ -f "$1" ] && tr -dc '0-9' < "$1"; }
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }
is_proc() { # pid, needle
  [ -r "/proc/$1/cmdline" ] || return 1
  tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null | grep -q "$2"
}

s_pid="$(readpid "$SUP" || true)"
r_pid="$(readpid "$SRV" || true)"

if alive "$s_pid" && is_proc "$s_pid" "supervise.sh"; then
  echo "stopping supervisor $s_pid"
  pgid="$(ps -o pgid= -p "$s_pid" 2>/dev/null | tr -d ' ')"
  if [ "$pgid" = "$s_pid" ]; then
    kill -TERM -- "-$s_pid" 2>/dev/null || kill -TERM "$s_pid" 2>/dev/null || true
  else
    kill -TERM "$s_pid" 2>/dev/null || true
  fi
fi
if alive "$r_pid" && is_proc "$r_pid" "server.py"; then
  kill -TERM "$r_pid" 2>/dev/null || true
fi

for _ in $(seq 1 100); do
  if ! alive "$s_pid" && ! alive "$r_pid"; then break; fi
  sleep 0.1
done

if alive "$s_pid"; then kill -KILL "$s_pid" 2>/dev/null || true; fi
if alive "$r_pid"; then kill -KILL "$r_pid" 2>/dev/null || true; fi
sleep 0.3
rm -f "$SUP" "$SRV"

if ss -ltn 2>/dev/null | grep -qE "[:.]$PORT[[:space:]]"; then
  echo "error: something is already listening on port $PORT:" >&2
  ss -ltnp 2>/dev/null | grep -E "[:.]$PORT[[:space:]]" >&2 || true
  exit 1
fi

setsid nohup "$HERE/supervise.sh" >> "$DATA/supervisor.log" 2>&1 < /dev/null &

for _ in $(seq 1 100); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    echo "mixer server up — pid $(readpid "$SRV" || echo '?')"
    echo "  local:   http://127.0.0.1:$PORT/"
    echo "  tailnet: http://<your-ip>:$PORT/"
    exit 0
  fi
  sleep 0.2
done

echo "error: server did not answer on port $PORT within 20s" >&2
echo "--- data/server.out (last 30 lines) ---" >&2
tail -n 30 "$DATA/server.out" >&2 || true
exit 1
