#!/usr/bin/env bash
# ==============================================================================
# Cross-Environment Lifecycle Controller for `gravity` v2.0 (Kunlun 1.2r + Linux 1.3)
# Supports: install-systemd | start | stop | status | test
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI_JS="$SCRIPT_DIR/cli.js"

HOST="${GRAVITY_HOST:-127.0.0.1}"
PORT="${GRAVITY_PORT:-8318}"
UPSTREAM="${GRAVITY_UPSTREAM:-http://127.0.0.1:8317}"
PRESET_MODE="${GRAVITY_PRESET_MODE:-kunlun_1.2r}"
MARKERS="${GRAVITY_MARKERS:-*}"
PERSONA_FILE="${GRAVITY_PERSONA_FILE:-}"
PID_FILE="${GRAVITY_PID_FILE:-/tmp/gravity-${PORT}.pid}"
LOG_FILE="${GRAVITY_LOG_FILE:-/tmp/gravity-${PORT}.log}"

ACTION="${1:-status}"
shift || true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; PID_FILE="/tmp/gravity-${PORT}.pid"; LOG_FILE="/tmp/gravity-${PORT}.log"; shift 2 ;;
    --upstream) UPSTREAM="$2"; shift 2 ;;
    --preset-mode) PRESET_MODE="$2"; shift 2 ;;
    --markers) MARKERS="$2"; shift 2 ;;
    --persona-file) PERSONA_FILE="$2"; shift 2 ;;
    *) shift ;;
  esac
done

NODE_BIN="$(command -v node || echo /usr/local/bin/node)"

case "$ACTION" in
  install-systemd)
    INSTALL_DIR="/opt/gravity"
    mkdir -p "$INSTALL_DIR/assets" "$INSTALL_DIR/lib"
    cp -f "$SCRIPT_DIR/engine.js" "$INSTALL_DIR/lib/engine.js"
    cp -f "$SCRIPT_DIR/server.js" "$INSTALL_DIR/lib/server.js"
    cp -f "$SCRIPT_DIR/cli.js" "$INSTALL_DIR/lib/cli.js"
    cp -f "$SKILL_DIR/assets/"*.json "$INSTALL_DIR/assets/"

    cat > /etc/systemd/system/gravity.service <<EOF
[Unit]
Description=Kunlun 1.2r / Linux 1.3 ToolCall Stream Tunnel Gateway (${HOST}:${PORT} -> ${UPSTREAM})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
Environment="GRAVITY_HOST=${HOST}"
Environment="GRAVITY_PORT=${PORT}"
Environment="GRAVITY_UPSTREAM=${UPSTREAM}"
Environment="GRAVITY_PRESET_MODE=${PRESET_MODE}"
Environment="GRAVITY_MARKERS=${MARKERS}"
Environment="GRAVITY_PERSONA_FILE=${PERSONA_FILE}"
ExecStart=${NODE_BIN} ${INSTALL_DIR}/lib/cli.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now gravity.service
    sleep 1
    systemctl status gravity.service --no-pager -l
    ;;

  start)
    if curl -fsS "http://${HOST}:${PORT}/health" >/dev/null 2>&1; then
      echo "[gravity] Already running on http://${HOST}:${PORT}"
      curl -fsS "http://${HOST}:${PORT}/health" ; echo ""
      exit 0
    fi
    EXTRA_ARGS=()
    if [[ -n "$PERSONA_FILE" ]]; then
      EXTRA_ARGS+=(--persona-file "$PERSONA_FILE")
    fi
    nohup "$NODE_BIN" "$CLI_JS" \
      --host "$HOST" \
      --port "$PORT" \
      --upstream "$UPSTREAM" \
      --preset-mode "$PRESET_MODE" \
      --markers "$MARKERS" \
      "${EXTRA_ARGS[@]}" \
      >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
    for _ in $(seq 1 20); do
      if curl -fsS "http://${HOST}:${PORT}/health" >/dev/null 2>&1; then
        echo "[gravity] Started (PID $(cat "$PID_FILE")) on http://${HOST}:${PORT}"
        curl -fsS "http://${HOST}:${PORT}/health" ; echo ""
        exit 0
      fi
      sleep 0.2
    done
    echo "[gravity] Failed to start; check $LOG_FILE" >&2
    exit 1
    ;;

  stop)
    if [[ -f "$PID_FILE" ]]; then
      PID="$(cat "$PID_FILE")"
      if kill -0 "$PID" 2>/dev/null; then
        kill "$PID"
        echo "[gravity] Stopped PID $PID"
      fi
      rm -f "$PID_FILE"
    else
      echo "[gravity] No PID file at $PID_FILE"
    fi
    ;;

  status)
    if curl -fsS "http://${HOST}:${PORT}/health" 2>/dev/null; then
      echo ""
    else
      echo "[gravity] Not responding on http://${HOST}:${PORT}/health"
      exit 1
    fi
    ;;

  test)
    # Inside a checkout the full suite is available; a standalone skill copy has
    # only these three scripts, so fall back to a syntax check.
    if [[ -f "$SKILL_DIR/../../test/all.mjs" ]]; then
      "$NODE_BIN" "$SKILL_DIR/../../test/all.mjs"
    else
      "$NODE_BIN" --check "$SCRIPT_DIR/engine.js"
      "$NODE_BIN" --check "$SCRIPT_DIR/server.js"
      "$NODE_BIN" --check "$SCRIPT_DIR/cli.js"
      echo "Syntax check OK"
    fi
    ;;

  *)
    echo "Usage: $0 {install-systemd|start|stop|status|test} [--host IP] [--port PORT] [--upstream URL] [--preset-mode kunlun_1.2r|linux_1.3] [--markers CSV] [--persona-file PATH]"
    exit 1
    ;;
esac
