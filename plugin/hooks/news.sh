#!/usr/bin/env bash
# SessionStart hook: one line of realm news so the game is sitting there every morning.
# Fails silently — the hook must never slow down or break a coding session.
set -u
CFG="${LORD_CONFIG_DIR:-$HOME/.config/lord}/config.json"
[ -f "$CFG" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

node - "$CFG" <<'EOF' 2>/dev/null
const fs = require("fs");
const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!cfg.api_key) process.exit(0);
const url = (process.env.LORD_API_URL || cfg.api_url || "https://lord-ebon.vercel.app") + "/v1/news?compact=1";
const ac = new AbortController();
setTimeout(() => ac.abort(), 1500);
fetch(url, { headers: { authorization: "Bearer " + cfg.api_key }, signal: ac.signal })
  .then(r => r.json())
  .then(j => {
    const news = (j.events || []).find(e => e.kind === "news_compact");
    const s = j.state || {};
    const lines = news && news.lines.length ? news.lines.slice(-3).join(" ") : "A quiet day in the realm.";
    const turns = `${s.forest_fights ?? "?"} forest fights, ${s.player_fights ?? "?"} player fights left.`;
    const mail = news && news.unread_mail ? ` ${news.unread_mail} unread message${news.unread_mail === 1 ? "" : "s"}.` : "";
    // stdout from a SessionStart hook lands in Claude's context, not on screen; the narrator skill relays it.
    console.log(`[Dragonmoor realm news — show this to the player in one line before anything else] ${lines} ${turns}${mail} /dragonmoor:lord to play.`);
  })
  .catch(() => {});
EOF
exit 0
