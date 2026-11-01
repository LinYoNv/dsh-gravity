#!/usr/bin/env bash
# ==============================================================================
# Cross-Environment Lifecycle Controller for `linux13-gateway`
# Supports: install-systemd | start | stop | status | test
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI_JS="$SCRIPT_DIR/cli.js"

HOST="${LINUX13_HOST:-127.0.0.1}"
PORT="${LINUX13_PORT:-8318}"
UPSTREAM="${LINUX13_UPSTREAM:-http://127.0.0.1:8317}"
MARKERS="${LINUX13_MARKERS:-<output_contract>,<Role_Profile>,<role_profile>,[Linux13]}"
PID_FILE="${LINUX13_PID_FILE:-/tmp/linux13-gateway-${PORT}.pid}"
LOG_FILE="${LINUX13_LOG_FILE:-/tmp/linux13-gateway-${PORT}.log}"

ACTION="${1:-status}"
shift || true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; PID_FILE="/tmp/linux13-gateway-${PORT}.pid"; LOG_FILE="/tmp/linux13-gateway-${PORT}.log"; shift 2 ;;
    --upstream) UPSTREAM="$2"; shift 2 ;;
    --markers) MARKERS="$2"; shift 2 ;;
    *) shift ;;
  esac
done

NODE_BIN="$(command -v node || echo /usr/local/bin/node)"

case "$ACTION" in
  install-systemd)
    INSTALL_DIR="/opt/linux13-gateway"
    mkdir -p "$INSTALL_DIR/assets" "$INSTALL_DIR/lib"
    cp -f "$SCRIPT_DIR/engine.js" "$INSTALL_DIR/lib/engine.js"
    cp -f "$SCRIPT_DIR/server.js" "$INSTALL_DIR/lib/server.js"
    cp -f "$SCRIPT_DIR/cli.js" "$INSTALL_DIR/lib/cli.js"
    cp -f "$SKILL_DIR/assets/linux_1.3.json" "$INSTALL_DIR/assets/linux_1.3.json"

    cat > /etc/systemd/system/linux13-gateway.service <<EOF
[Unit]
Description=Linux 1.3 ToolCall Stream Tunnel Gateway (${HOST}:${PORT} -> ${UPSTREAM})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
Environment="LINUX13_HOST=${HOST}"
Environment="LINUX13_PORT=${PORT}"
Environment="LINUX13_UPSTREAM=${UPSTREAM}"
Environment="LINUX13_MARKERS=${MARKERS}"
ExecStart=${NODE_BIN} ${INSTALL_DIR}/lib/cli.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now linux13-gateway.service
    sleep 1
    systemctl status linux13-gateway.service --no-pager -l
    ;;

  start)
    if curl -fsS "http://${HOST}:${PORT}/health" >/dev/null 2>&1; then
      echo "[linux13-gateway] Already running on http://${HOST}:${PORT}"
      curl -fsS "http://${HOST}:${PORT}/health" ; echo ""
      exit 0
    fi
    nohup "$NODE_BIN" "$CLI_JS" \
      --host "$HOST" \
      --port "$PORT" \
      --upstream "$UPSTREAM" \
      --markers "$MARKERS" \
      >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
    for _ in $(seq 1 20); do
      if curl -fsS "http://${HOST}:${PORT}/health" >/dev/null 2>&1; then
        echo "[linux13-gateway] Started (PID $(cat "$PID_FILE")) on http://${HOST}:${PORT}"
        curl -fsS "http://${HOST}:${PORT}/health" ; echo ""
        exit 0
      fi
      sleep 0.2
    done
    echo "[linux13-gateway] Failed to start; check $LOG_FILE" >&2
    exit 1
    ;;

  stop)
    if [[ -f "$PID_FILE" ]]; then
      PID="$(cat "$PID_FILE")"
      if kill -0 "$PID" 2>/dev/null; then
        kill "$PID"
        echo "[linux13-gateway] Stopped PID $PID"
      fi
      rm -f "$PID_FILE"
    else
      echo "[linux13-gateway] No PID file at $PID_FILE"
    fi
    ;;

  status)
    if curl -fsS "http://${HOST}:${PORT}/health" 2>/dev/null; then
      echo ""
    else
      echo "[linux13-gateway] Not responding on http://${HOST}:${PORT}/health"
      exit 1
    fi
    ;;

  test)
    if [[ -f "$SKILL_DIR/../../test/run-tests.mjs" ]]; then
      "$NODE_BIN" "$SKILL_DIR/../../test/run-tests.mjs"
    else
      "$NODE_BIN" --check "$SCRIPT_DIR/engine.js"
      "$NODE_BIN" --check "$SCRIPT_DIR/server.js"
      "$NODE_BIN" --check "$SCRIPT_DIR/cli.js"
      echo "Syntax check OK"
    fi
    ;;

  *)
    echo "Usage: $0 {install-systemd|start|stop|status|test} [--host IP] [--port PORT] [--upstream URL] [--markers CSV]"
    exit 1
    ;;
esac
