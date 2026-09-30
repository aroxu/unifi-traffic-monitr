#!/bin/sh
# Install the UniFi traffic monitor agent on a UniFi OS gateway.
#   curl -sSLf https://raw.githubusercontent.com/aroxu/unifi-traffic-monitr/main/agent/install.sh | sh
# Pass a version such as v0.1.0 to pin a release. Set AGENT_PACKAGE_FILE to
# install a package that was copied to the device.
set -eu

VERSION="${1:-latest}"
REPO="${AGENT_REPO:-aroxu/unifi-traffic-monitr}"
ASSET="unifi-traffic-agent-linux-arm64.tgz"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

if [ -n "${AGENT_PACKAGE_FILE:-}" ]; then
  cp "$AGENT_PACKAGE_FILE" "$WORKDIR/$ASSET"
else
  if [ "$VERSION" = "latest" ]; then
    BASE="https://github.com/$REPO/releases/latest/download"
  else
    BASE="https://github.com/$REPO/releases/download/agent-$VERSION"
  fi
  curl -sSLf --ipv4 -o "$WORKDIR/$ASSET" "$BASE/$ASSET"
  curl -sSLf --ipv4 -o "$WORKDIR/$ASSET.sha256" "$BASE/$ASSET.sha256"
  (cd "$WORKDIR" && sha256sum -c "$ASSET.sha256")
fi

mkdir -p /data
tar xzf "$WORKDIR/$ASSET" -C /data
chmod 755 /data/unifi-traffic-agent/manage.sh /data/unifi-traffic-agent/bin/unifi-traffic-agent
/data/unifi-traffic-agent/manage.sh install
