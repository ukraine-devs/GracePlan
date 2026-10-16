#!/usr/bin/env bash
set -euo pipefail
umask 077

# /workspaces survives a Codespaces stop/start and container rebuild. Keep the
# browser profile OUTSIDE the repository so cookies can never enter a commit.
profile_dir=/workspaces/.grace-private/chrome
mkdir -p "$profile_dir"
chmod 700 /workspaces/.grace-private "$profile_dir"

# Do not weaken Chrome's sandbox or expose a DevTools/CDP port.
# A second invocation must not launch a second copy against the same profile.
if pgrep -f '^/opt/google/chrome/chrome .*--user-data-dir=/workspaces/.grace-private/chrome' >/dev/null; then
  exit 0
fi

# Desktop startup is asynchronous. A bounded wait lets TigerVNC create DISPLAY.
for attempt in {1..30}; do
  if xdpyinfo -display "${DISPLAY:-:1}" >/dev/null 2>&1; then
    nohup google-chrome-stable \
      --user-data-dir="$profile_dir" \
      --disable-dev-shm-usage \
      --no-first-run \
      https://chatgpt.com/ \
      > /tmp/grace-chrome.log 2>&1 < /dev/null &
    exit 0
  fi
  sleep 1
done
printf '%s\n' 'Desktop did not become ready. Restart the codespace; see /tmp/grace-chrome.log.' >&2
exit 1
