#!/usr/bin/env bash
# Build and package the agent. Run from the repository root or agent/.
#   agent/build/build.sh v0.1.0 agent/dist
set -euo pipefail

VERSION="${1:?version required, for example v0.1.0}"
AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$(mkdir -p "${2:-$AGENT_DIR/dist}" && cd "${2:-$AGENT_DIR/dist}" && pwd)"

cd "$AGENT_DIR"
for arch in arm64 amd64; do
  work="$(mktemp -d)"
  root="$work/unifi-traffic-agent"
  mkdir -p "$root/bin"
  CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -trimpath \
    -ldflags "-s -w -X main.version=$VERSION" -o "$root/bin/unifi-traffic-agent" ./cmd/unifi-traffic-agent
  cp package/manage.sh package/unifi-traffic-agent.service package/agent.env.example "$root/"
  echo "$VERSION" > "$root/VERSION"
  chmod 755 "$root/manage.sh" "$root/bin/unifi-traffic-agent"
  asset="unifi-traffic-agent-linux-$arch.tgz"
  tar czf "$DEST/$asset" -C "$work" unifi-traffic-agent --owner=0 --group=0
  (cd "$DEST" && sha256sum "$asset" > "$asset.sha256")
  rm -rf "$work"
  echo "built $DEST/$asset"
done
