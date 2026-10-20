#!/usr/bin/env bash
# UserPromptSubmit hook: one line when new Dragon's Door mail has arrived, then quiet until more does.
# Never blocks or breaks the prompt. Set DRAGONS_DOOR_NOTIFY=0 to turn it off.
set -u
[ "${DRAGONS_DOOR_NOTIFY:-${LORD_NOTIFY:-1}}" = "0" ] && exit 0
DIR="${DRAGONS_DOOR_CONFIG_DIR:-${LORD_CONFIG_DIR:-$HOME/.config/dragons-door}}"
[ -f "$DIR/config.json" ] || { [ -f "$HOME/.config/lord/config.json" ] && DIR="$HOME/.config/lord"; }
CFG="$DIR/config.json"
[ -f "$CFG" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

node - "$CFG" "$DIR/mail-seen" <<'JS' 2>/dev/null
const fs = require("fs");
const [cfgPath, seenPath] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
if (!cfg.api_key) process.exit(0);
const url = (process.env.DRAGONS_DOOR_API_URL || process.env.LORD_API_URL || (cfg.api_url && !/lord-ebon\.vercel\.app/.test(cfg.api_url) ? cfg.api_url : "") || "https://dragons-door-api.vercel.app") + "/v1/mail/peek";
let seen = 0; try { seen = Number(fs.readFileSync(seenPath, "utf8")) || 0; } catch {}
const ac = new AbortController(); setTimeout(() => ac.abort(), 1200);
fetch(url, { headers: { authorization: "Bearer " + cfg.api_key }, signal: ac.signal })
  .then(r => r.json())
  .then(j => {
    if (!j.unread || !(j.latest > seen)) return;
    fs.writeFileSync(seenPath, String(j.latest));
    const who = (j.from || []).slice(0, 3).join(", ");
    console.log(`[Dragon's Door: ${j.unread} new message${j.unread === 1 ? "" : "s"}${who ? " from " + who : ""}. Mention this to the user in one short line at the end of your reply. Don't read the messages; they open them with /dragons-door:enter.]`);
  })
  .catch(() => {});
JS
exit 0
