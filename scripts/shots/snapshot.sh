#!/usr/bin/env bash
# Puts a committed tree of MiniDSH at /opt/minidsh with its own production
# install, and a Node at /opt/minidsh-node, for the pictures: every path a
# session records or a screen shows is then a neutral one, never a home
# directory. Run as root (under WSL 2 on this project's Windows host), and
# never under /tmp, which WSL clears whenever its VM idles.
#
#   git archive --format=tar -o head.tar HEAD      (in the repository)
#   snapshot.sh <head.tar> [<node binary>]         (default: the node on PATH)
set -euo pipefail
TAR="$1"
NODE_SRC="${2:-$(command -v node)}"
mkdir -p /opt/minidsh-node/bin
[ "$NODE_SRC" -ef /opt/minidsh-node/bin/node ] || cp -f "$NODE_SRC" /opt/minidsh-node/bin/node
export PATH=/opt/minidsh-node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
rm -rf /opt/minidsh.new
mkdir -p /opt/minidsh.new
tar -xf "$TAR" -C /opt/minidsh.new
(cd /opt/minidsh.new && pnpm install --prod --frozen-lockfile > /opt/minidsh-install.log 2>&1) || { echo "install failed"; tail -n 15 /opt/minidsh-install.log; exit 1; }
rm -rf /opt/minidsh
mv /opt/minidsh.new /opt/minidsh
echo "snapshot: $(node /opt/minidsh/bin/minidsh.js --version) at /opt/minidsh, node $(node --version) at $(command -v node)"
