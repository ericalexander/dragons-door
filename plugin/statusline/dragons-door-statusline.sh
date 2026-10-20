#!/usr/bin/env bash
# Dragon's Door status line: runs your previous status line, then adds "✉ N" when mail is waiting.
# Installed by /dragons-door:statusline. Never blocks on the network: it shows the cached count and
# refreshes the cache in the background at most once a minute. Fails silent.
input=$(cat)
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
DIR="${DRAGONS_DOOR_CONFIG_DIR:-${LORD_CONFIG_DIR:-$HOME/.config/dragons-door}}"
[ -f "$DIR/config.json" ] || { [ -f "$HOME/.config/lord/config.json" ] && DIR="$HOME/.config/lord"; }
CFG="$DIR/config.json"
CACHE="$DIR/statusline-unread"
PREV="$CLAUDE_DIR/dragons-door-statusline.prev"

prev_out=""
if [ -s "$PREV" ]; then
  prev_out=$(printf '%s' "$input" | sh -c "$(cat "$PREV")" 2>/dev/null)
fi

now=$(date +%s); ts=0; n=0
[ -f "$CACHE" ] && read -r ts n < "$CACHE" 2>/dev/null
case "$ts" in ''|*[!0-9]*) ts=0;; esac
case "$n" in ''|*[!0-9]*) n=0;; esac

if [ $((now - ts)) -ge 60 ] && [ -f "$CFG" ] && command -v curl >/dev/null 2>&1; then
  (
    key=$(sed -n 's/.*"api_key"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CFG" | head -1)
    [ -n "$key" ] || exit 0
    url="${DRAGONS_DOOR_API_URL:-${LORD_API_URL:-$(sed -n 's/.*"api_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CFG" | head -1)}}"
    case "$url" in *lord-ebon.vercel.app*) url="";; esac   # retired address; it redirects and drops the key
    url="${url:-https://dragons-door-api.vercel.app}"
    # stamp first so a slow or failing server doesn't get hammered
    printf '%s %s\n' "$(date +%s)" "$n" > "$CACHE.tmp" && mv "$CACHE.tmp" "$CACHE"
    r=$(curl -fsS --max-time 3 -H "authorization: Bearer $key" "$url/v1/mail/peek" 2>/dev/null) || exit 0
    c=$(printf '%s' "$r" | sed -n 's/.*"unread":\([0-9]*\).*/\1/p')
    [ -n "$c" ] && printf '%s %s\n' "$(date +%s)" "$c" > "$CACHE.tmp" && mv "$CACHE.tmp" "$CACHE"
  ) >/dev/null 2>&1 &
fi

badge=""
[ "$n" -gt 0 ] 2>/dev/null && badge="✉ $n"

if [ -n "$prev_out" ]; then
  first=$(printf '%s\n' "$prev_out" | head -n 1)
  rest=$(printf '%s\n' "$prev_out" | tail -n +2)
  if [ -n "$badge" ]; then printf '%s  %s\n' "$first" "$badge"; else printf '%s\n' "$first"; fi
  [ -n "$rest" ] && printf '%s\n' "$rest"
elif [ -n "$badge" ]; then
  printf '%s\n' "$badge"
fi
exit 0
