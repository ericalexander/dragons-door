#!/usr/bin/env bash
# End-to-end smoke test against a running server. Usage: ./smoke.sh [http://localhost:8787]
set -euo pipefail
API="${1:-http://localhost:8787}/v1"
SUF=$RANDOM

j() { python3 -c "import sys,json; d=json.load(sys.stdin); print(('ERROR: '+d['error']+' — '+d.get('message','')) if 'error' in d else ($1))"; }

echo "== register three players"
reg() { curl -s -X POST "$API/register" -H 'content-type: application/json' -d "{\"name\":\"$1\",\"class\":\"$2\"}" | j 'd["api_key"]'; }
EK=$(reg "Eric$SUF" warrior); BK=$(reg "Bob$SUF" thief); SK=$(reg "Scout$SUF" mage)
echo "  keys issued: ${EK:0:8}… ${BK:0:8}… ${SK:0:8}…"

e() { curl -s -H "authorization: Bearer $EK" -H 'content-type: application/json' "$@"; }
b() { curl -s -H "authorization: Bearer $BK" -H 'content-type: application/json' "$@"; }
s() { curl -s -H "authorization: Bearer $SK" -H 'content-type: application/json' "$@"; }

echo "== status"
e "$API/status" | j '"hp=%s gold=%s forest=%s actions=%s" % (d["state"]["hp"], d["state"]["gold"], d["state"]["forest_fights"], d["actions"])'

echo "== scout runs the forest until out of fights or dead"
for f in $(seq 1 10); do
  K=$(s -X POST "$API/forest" | j '",".join(x["kind"] for x in d["events"])')
  echo "  forest $f: $K"
  case "$K" in *no_fights_left*|ERROR*) break;; *encounter*) ;; *) continue;; esac
  for i in $(seq 1 40); do
    K=$(s -X POST "$API/fight" -d '{"action":"attack"}' | j '",".join(x["kind"] for x in d["events"])')
    case "$K" in *monster_slain*|*player_died*|*no_encounter*|ERROR*) echo "    $i rounds: $K"; break;; esac
  done
  case "$K" in *player_died*) break;; esac
  s -X POST "$API/healer" -d '{"hp":"all"}' > /dev/null
done
s "$API/status" | j '"hp=%s/%s gold=%s exp=%s alive=%s forest=%s" % (d["state"]["hp"], d["state"]["max_hp"], d["state"]["gold"], d["state"]["exp"], d["state"]["alive"], d["state"]["forest_fights"])'

echo "== inn, then bank the rest (eric)"
e -X POST "$API/inn" | j '[x["kind"] for x in d["events"]]'
e -X POST "$API/bank" -d '{"op":"deposit","amount":"all"}' | j '[x["kind"] for x in d["events"]]'

echo "== bob challenges eric (should be refused: eric is at the inn)"
b -X POST "$API/challenge" -d "{\"name\":\"Eric$SUF\"}" | j '[x["kind"] for x in d["events"]]'

echo "== eric challenges bob (bob is in the fields)"
e -X POST "$API/challenge" -d "{\"name\":\"Bob$SUF\"}" | j '[x["kind"] for x in d["events"] if x["kind"]!="pvp_log"]'

echo "== bob's next status drains the mailbox"
b "$API/status" | j '[(x["kind"], x.get("what")) for x in d["events"]]'

echo "== tavern"
e -X POST "$API/tavern" -d '{"body":"Bob, stay out of the fields."}' | j '[x["kind"] for x in d["events"]]'
b "$API/tavern" | j '[m["author"]+": "+m["body"] for x in d["events"] if x["kind"]=="tavern_messages" for m in x["messages"]]'

echo "== flirt + rankings + news"
e -X POST "$API/flirt" | j '[x for x in d["events"] if x["kind"]=="flirt"][0]["outcome"]'
e "$API/rankings" | j '[p["name"] for x in d["events"] if x["kind"]=="rankings" for p in x["players"]][:5]'
e "$API/news?compact=1" | j '"\n".join("  "+l for x in d["events"] if x["kind"]=="news_compact" for l in x["lines"])'

echo "== bad key"
curl -s -H "authorization: Bearer nope" "$API/status"; echo
echo "OK"
