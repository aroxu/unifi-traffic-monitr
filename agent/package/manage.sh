#!/bin/sh
# Manage the UniFi traffic monitor agent on UniFi OS.
# Program files and settings live in /data so the agent survives reboots and
# firmware updates. The running agent keeps traffic data in memory and never
# writes to /data. The systemd unit is copied into /etc as a plain file, and a
# /data/on_boot.d hook repairs it if it is ever missing.
set -eu

AGENT_ROOT="${AGENT_ROOT:-/data/unifi-traffic-agent}"
SYSTEMD_UNIT_DIR="${SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
BOOT_HOOK_DIR="${BOOT_HOOK_DIR:-/data/on_boot.d}"
REPO="${AGENT_REPO:-aroxu/unifi-traffic-monitr}"
UNIT="unifi-traffic-agent.service"
BIN="$AGENT_ROOT/bin/unifi-traffic-agent"
ENV_FILE="$AGENT_ROOT/agent.env"
BOOT_HOOK="$BOOT_HOOK_DIR/20-unifi-traffic-agent.sh"
DEFAULT_PORT=8790
ASSET="unifi-traffic-agent-linux-arm64.tgz"

die() {
  echo "error: $*" >&2
  exit 1
}

env_value() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1
}

check_platform() {
  [ "$(uname -m)" = "aarch64" ] || die "this package supports aarch64 UniFi OS devices only"
  if command -v ubnt-device-info >/dev/null 2>&1; then
    major="$(ubnt-device-info firmware_detail | grep -oE '^[0-9]+' || true)"
    [ -n "$major" ] && [ "$major" -ge 2 ] || die "UniFi OS 2.x or later is required"
  fi
  [ "$(cat /proc/sys/net/netfilter/nf_conntrack_acct 2>/dev/null || echo 0)" = "1" ] || \
    die "conntrack byte accounting is disabled on this device"
  command -v systemctl >/dev/null 2>&1 || die "systemd is required"
}

default_listen() {
  addr="$(ip -4 -o addr show dev br0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n 1)"
  [ -n "$addr" ] || die "could not find the br0 address; set AGENT_LISTEN=IP:PORT and retry"
  echo "$addr:$DEFAULT_PORT"
}

listen_hosts() {
  env_value AGENT_LISTEN | tr ',' '\n' | sed -E 's/^\[([^]]+)\]:[0-9]+$/\1/; s/:[0-9]+$//' | paste -sd, -
}

ensure_config() {
  if [ ! -f "$ENV_FILE" ]; then
    listen="${AGENT_LISTEN:-}"
    [ -n "$listen" ] || listen="$(default_listen)"
    token="$("$BIN" gen-token)"
    (
      umask 077
      cat > "$ENV_FILE" <<EOF
AGENT_LISTEN=$listen
AGENT_TOKEN=$token
AGENT_BUFFER_HOURS=24
AGENT_LIVE_INTERVAL_MS=1000
AGENT_IDLE_INTERVAL_MS=10000
AGENT_CLIENT_INTERFACES=br*
EOF
    )
    echo "Created $ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
  if [ ! -f "$AGENT_ROOT/tls/cert.pem" ] || [ ! -f "$AGENT_ROOT/tls/key.pem" ]; then
    "$BIN" gen-cert -data-dir "$AGENT_ROOT" -hosts "$(listen_hosts)"
    echo "Created TLS certificate"
  fi
  ensure_agent_id
}

# The agent reads this ID but cannot write it, so create it once here.
ensure_agent_id() {
  id_file="$AGENT_ROOT/state/agent-id"
  [ -s "$id_file" ] && return 0
  mkdir -p "$AGENT_ROOT/state"
  (
    umask 077
    od -An -tx1 -N16 /dev/urandom | tr -d ' \n' > "$id_file.tmp"
    echo >> "$id_file.tmp"
  )
  mv "$id_file.tmp" "$id_file"
}

# Versions before 0.2.0 kept five-minute buckets and a checkpoint on disk.
remove_disk_buckets() {
  rm -rf "$AGENT_ROOT/buckets" "$AGENT_ROOT/state/open-buckets.json" "$AGENT_ROOT/state/open-buckets.json.tmp"
}

# Copy the unit as a regular file. A symlink into /data could be unreadable
# to systemd early in boot.
install_unit() {
  src="$AGENT_ROOT/$UNIT"
  dst="$SYSTEMD_UNIT_DIR/$UNIT"
  if [ -L "$dst" ] || [ ! -f "$dst" ] || ! cmp -s "$src" "$dst"; then
    rm -f "$dst"
    cp "$src" "$dst"
  fi
  systemctl daemon-reload
  systemctl enable "$UNIT" >/dev/null
}

install_boot_hook() {
  mkdir -p "$BOOT_HOOK_DIR"
  cat > "$BOOT_HOOK.tmp" <<EOF
#!/bin/sh
# Repairs and starts the UniFi traffic monitor agent at boot.
exec $AGENT_ROOT/manage.sh on-boot
EOF
  chmod 755 "$BOOT_HOOK.tmp"
  mv "$BOOT_HOOK.tmp" "$BOOT_HOOK"
}

agent_url() {
  first="$(env_value AGENT_LISTEN | cut -d, -f1)"
  echo "wss://$first/v1/stream"
}

show_info() {
  echo "Version:     $("$BIN" version)"
  echo "Stream URL:  $(agent_url)"
  echo "Certificate: $("$BIN" fingerprint -data-dir "$AGENT_ROOT")"
  echo "Token:       run '$0 token' to print it"
}

show_status() {
  if systemctl is-active --quiet "$UNIT"; then
    echo "Agent is running ($("$BIN" version))"
  else
    echo "Agent is not running"
  fi
  first="$(env_value AGENT_LISTEN | cut -d, -f1)"
  if [ -n "$first" ] && command -v curl >/dev/null 2>&1; then
    if curl -skf --max-time 3 "https://$first/healthz" >/dev/null; then
      echo "Health check: ok"
    else
      echo "Health check: no response on $first"
    fi
  fi
}

rotate_token() {
  [ -f "$ENV_FILE" ] || die "not installed"
  token="$("$BIN" gen-token)"
  sed -i "s/^AGENT_TOKEN=.*/AGENT_TOKEN=$token/" "$ENV_FILE"
  systemctl restart "$UNIT"
  echo "Token rotated. Update UNIFI_AGENT_TOKEN on the collector ('$0 token' prints it)."
}

download_package() {
  version="$1"
  dest="$2"
  if [ "$version" = "latest" ]; then
    base="https://github.com/$REPO/releases/latest/download"
  else
    base="https://github.com/$REPO/releases/download/agent-$version"
  fi
  curl -sSLf --ipv4 -o "$dest/$ASSET" "$base/$ASSET"
  curl -sSLf --ipv4 -o "$dest/$ASSET.sha256" "$base/$ASSET.sha256"
  (cd "$dest" && sha256sum -c "$ASSET.sha256" >/dev/null) || die "checksum mismatch for $ASSET"
}

update_agent() {
  workdir="$(mktemp -d)"
  trap 'rm -rf "$workdir"' EXIT
  download_package "${1:-latest}" "$workdir"
  tar xzf "$workdir/$ASSET" -C "$workdir"
  new="$workdir/unifi-traffic-agent"
  [ -x "$new/bin/unifi-traffic-agent" ] || die "package is missing the agent binary"
  echo "Updating $("$BIN" version) -> $("$new/bin/unifi-traffic-agent" version)"
  cp "$new/bin/unifi-traffic-agent" "$BIN.new"
  mv "$BIN.new" "$BIN"
  for f in manage.sh "$UNIT" agent.env.example VERSION; do
    [ -f "$new/$f" ] && cp "$new/$f" "$AGENT_ROOT/$f.new" && mv "$AGENT_ROOT/$f.new" "$AGENT_ROOT/$f"
  done
  chmod 755 "$AGENT_ROOT/manage.sh" "$BIN"
  rm -rf "$workdir"
  trap - EXIT
  # Finish with the new script so its setup steps apply.
  exec "$AGENT_ROOT/manage.sh" finish-update
}

finish_update() {
  ensure_agent_id
  remove_disk_buckets
  install_unit
  systemctl restart "$UNIT"
  echo "Agent updated"
}

uninstall_agent() {
  systemctl disable --now "$UNIT" >/dev/null 2>&1 || true
  rm -f "$SYSTEMD_UNIT_DIR/$UNIT" "$BOOT_HOOK"
  systemctl daemon-reload
  if [ "${1:-}" = "--purge" ]; then
    rm -rf "$AGENT_ROOT"
    echo "Agent and its data removed"
  else
    echo "Agent removed. Data kept in $AGENT_ROOT (use --purge to delete it)."
  fi
}

case "${1:-}" in
  install)
    check_platform
    ensure_config
    remove_disk_buckets
    install_unit
    install_boot_hook
    systemctl restart "$UNIT"
    sleep 2
    show_status
    show_info
    ;;
  start) systemctl start "$UNIT" ;;
  stop) systemctl stop "$UNIT" ;;
  restart) systemctl restart "$UNIT" ;;
  status) show_status ;;
  info) show_info ;;
  token) env_value AGENT_TOKEN ;;
  rotate-token) rotate_token ;;
  update) update_agent "${2:-latest}" ;;
  finish-update) finish_update ;;
  uninstall) uninstall_agent "${2:-}" ;;
  on-boot)
    [ -f "$ENV_FILE" ] || exit 0
    remove_disk_buckets
    install_unit
    systemctl start "$UNIT"
    ;;
  *)
    echo "Usage: $0 {install|start|stop|restart|status|info|token|rotate-token|update [version]|uninstall [--purge]|on-boot}"
    exit 1
    ;;
esac
