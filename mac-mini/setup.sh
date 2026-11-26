#!/usr/bin/env bash
# Open Verse Ai: one-time Mac mini setup (run ON the Mac mini, from your own account).
#
#   bash setup.sh           set everything up (asks before each change)
#   bash setup.sh --check   only report what is and isn't set up; changes nothing
#   bash setup.sh --yes     set everything up without asking (still asks for your password for sudo)
#
# What it does:
#   1. Power: never sleep, start automatically after a power failure, wake for network, restart after a freeze
#   2. Remote access: turns on Remote Login (SSH)
#   3. Checks FileVault + automatic login (these two must be changed in System Settings)
#   4. Installs Ollama (Homebrew), starts it at every login, downloads models that fit your RAM
#   5. Optional: installs the Command Center heartbeat if ~/trading-bot is on this Mac
#   6. Optional: sets up the trading bot itself if ~/trading-bot is on this Mac (its own setup-mac-mini.sh --bot-only)
# It never stores or asks for your account password itself, and never opens Ollama to the internet.
set -uo pipefail

MODE=apply; YES=0
for a in "$@"; do
  case "$a" in
    --check) MODE=check ;;
    --yes|-y) YES=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "Unknown option: $a (use --check, --yes or --help)"; exit 2 ;;
  esac
done

B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'
ok()   { echo "  ${G}✓${N} $*"; }
warn() { echo "  ${Y}!${N} $*"; TODO+=("$*"); }
bad()  { echo "  ${R}✗${N} $*"; TODO+=("$*"); }
step() { echo; echo "${B}$*${N}"; }
ask()  { [ "$MODE" = check ] && return 1; [ "$YES" = 1 ] && return 0; read -r -p "  → $1 [Y/n] " r; [[ -z "$r" || "$r" =~ ^[Yy] ]]; }
TODO=()

# ---------- 0. basics ----------
step "0. This Mac"
[ "$(uname)" = Darwin ] || { echo "This script is for macOS."; exit 1; }
[ "$(id -u)" -ne 0 ] || { echo "Run it from your normal account, not with sudo (it asks for sudo itself)."; exit 1; }
MODEL_ID=$(sysctl -n hw.model 2>/dev/null)
RAM_GB=$(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 ))
CHIP=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo unknown)
echo "  $CHIP · ${RAM_GB} GB RAM · $MODEL_ID · macOS $(sw_vers -productVersion)"
case "$MODEL_ID" in Macmini*|Mac14,3|Mac14,12|Mac16,10|Mac16,11) ok "Mac mini detected" ;; *) warn "This doesn't look like a Mac mini ($MODEL_ID). Settings still apply, but laptops shouldn't run 24/7 on battery." ;; esac
[ "$(uname -m)" = arm64 ] && ok "Apple Silicon" || warn "Intel Mac: local models will be slow"

# ---------- 1. power ----------
step "1. Stay on 24/7 and restart after a power cut"
pm=$(pmset -g 2>/dev/null)
val() { echo "$pm" | awk -v k="$1" '$1==k {print $2; exit}'; }
need_pm=0; todo_before=${#TODO[@]}
[ "$(val sleep)" = 0 ] && ok "System sleep: never" || { bad "System sleep is on ($(val sleep) min)"; need_pm=1; }
[ "$(val disksleep)" = 0 ] && ok "Disk sleep: never" || { warn "Disk sleep is on"; need_pm=1; }
[ "$(val autorestart)" = 1 ] && ok "Start automatically after a power failure: on" || { bad "Start after power failure: off"; need_pm=1; }
[ "$(val womp)" = 1 ] && ok "Wake for network access: on" || { warn "Wake for network access: off"; need_pm=1; }
if [ "$need_pm" = 1 ] && ask "Apply: never sleep, auto-start after power failure, wake for network (needs your password)?"; then
  sudo pmset -a sleep 0 disksleep 0 displaysleep 10 autorestart 1 womp 1 powernap 0 tcpkeepalive 1 \
    && { ok "Power settings applied"; TODO=("${TODO[@]:0:$todo_before}"); } || bad "pmset failed"
  sudo systemsetup -setrestartfreeze on >/dev/null 2>&1 && ok "Restart automatically if the system freezes: on" || true
fi

# ---------- 2. remote access ----------
step "2. Control it without a display"
if systemsetup -getremotelogin 2>/dev/null | grep -qi ': On'; then ok "Remote Login (SSH): on"
elif sudo -n true 2>/dev/null && sudo systemsetup -getremotelogin 2>/dev/null | grep -qi ': On'; then ok "Remote Login (SSH): on"
else
  warn "Remote Login (SSH) looks off"
  if ask "Turn on Remote Login (SSH)?"; then
    if sudo systemsetup -setremotelogin on >/dev/null 2>&1; then ok "Remote Login turned on"
    else warn "macOS blocked this from Terminal. Turn it on in System Settings → General → Sharing → Remote Login."; fi
  fi
fi
warn "Screen Sharing can't be turned on from a script: System Settings → General → Sharing → Screen Sharing"
echo "  This Mac on your network: ${B}$(scutil --get LocalHostName 2>/dev/null).local${N}  (ssh $(whoami)@$(scutil --get LocalHostName 2>/dev/null).local)"

# ---------- 3. FileVault + automatic login ----------
step "3. Boot to the desktop with no password screen"
if fdesetup status 2>/dev/null | grep -q "FileVault is On"; then
  bad "FileVault is ON: after a power cut the Mac waits at a password screen. Turn it off in System Settings → Privacy & Security → FileVault (tradeoff: a stolen disk can be read)."
else ok "FileVault: off (needed for unattended restarts)"; fi
AUTO=$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || true)
if [ "$AUTO" = "$(whoami)" ]; then ok "Automatic login: $AUTO"
elif [ -n "$AUTO" ]; then warn "Automatic login is set to '$AUTO', not you ($(whoami))"
else bad "Automatic login is off: System Settings → Users & Groups → Automatically log in as → $(whoami)"; fi

# ---------- 4. Ollama + models ----------
step "4. Local AI models (Ollama)"
BREW=""
for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && BREW="$b" && break; done
if [ -z "$BREW" ]; then
  bad 'Homebrew is not installed. Install it from https://brew.sh (paste the command shown there), then run this script again.'
else
  ok "Homebrew: $BREW"
  eval "$("$BREW" shellenv)"
  if command -v ollama >/dev/null 2>&1; then ok "Ollama installed ($(ollama --version 2>/dev/null | head -1))"
  elif ask "Install Ollama with Homebrew?"; then "$BREW" install ollama && ok "Ollama installed" || bad "Ollama install failed"
  else bad "Ollama not installed"; fi

  if command -v ollama >/dev/null 2>&1; then
    if "$BREW" services list 2>/dev/null | awk '$1=="ollama"{print $2}' | grep -q started; then ok "Ollama starts automatically at login"
    elif ask "Start Ollama now and at every login (brew services)?"; then "$BREW" services start ollama >/dev/null && ok "Ollama service started" || bad "Could not start the Ollama service"
    else warn "Ollama won't start by itself after a reboot"; fi

    for i in $(seq 1 20); do curl -s -m 2 http://127.0.0.1:11434/api/version >/dev/null && break; sleep 1; done
    if curl -s -m 2 http://127.0.0.1:11434/api/version >/dev/null; then
      ok "Ollama is answering on 127.0.0.1:11434 (this Mac only, not the internet)"
      # Models that fit: leave ~4-6 GB for macOS.
      if   [ "$RAM_GB" -ge 32 ]; then MODELS=(qwen3:14b gemma3:12b llama3.1:8b)
      elif [ "$RAM_GB" -ge 16 ]; then MODELS=(qwen3:8b gemma3:4b)
      else                            MODELS=(qwen3:4b llama3.2:3b); fi
      echo "  Models for ${RAM_GB} GB: ${MODELS[*]}  (check ollama.com/library for newer sizes)"
      have=$(ollama list 2>/dev/null | awk 'NR>1{print $1}')
      for m in "${MODELS[@]}"; do
        if echo "$have" | grep -qx "$m"; then ok "$m already downloaded"
        elif ask "Download $m (a few GB)?"; then ollama pull "$m" && ok "$m downloaded" || warn "Couldn't download $m (name may have changed; see ollama.com/library)"
        else warn "$m not downloaded"; fi
      done
      first=$(ollama list 2>/dev/null | awk 'NR==2{print $1}')
      if [ -n "$first" ] && [ "$MODE" = apply ]; then
        echo "  Test: asking $first \"What is 15% of 240? Answer with just the number.\""
        ans=$(curl -s -m 180 http://127.0.0.1:11434/api/generate -d "{\"model\":\"$first\",\"prompt\":\"What is 15% of 240? Answer with just the number.\",\"stream\":false,\"think\":false}" \
          | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("response","").strip()[:80])' 2>/dev/null)
        [ -n "$ans" ] && ok "Model answered: $ans" || warn "The test question got no answer"
      fi
    else bad "Ollama isn't answering yet (start it with: brew services start ollama)"; fi
  fi
fi

# ---------- 5. Command Center heartbeat (optional) ----------
step "5. Command Center heartbeat"
PL=com.commandcenter.heartbeat
if [ -f "$HOME/trading-bot/scripts/launchd/$PL.plist" ] && [ -f "$HOME/trading-bot/scripts/mac_mini_heartbeat.py" ]; then
  if launchctl print "gui/$(id -u)/$PL" >/dev/null 2>&1; then ok "Heartbeat is running (Command Center shows this Mac as Online)"
  elif ask "Install the heartbeat so Command Center shows this Mac mini as Online?"; then
    sed "s#/Users/[^/]*/trading-bot#$HOME/trading-bot#g" "$HOME/trading-bot/scripts/launchd/$PL.plist" > "$HOME/Library/LaunchAgents/$PL.plist"
    launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$PL.plist" 2>/dev/null && ok "Heartbeat installed" || warn "Couldn't start the heartbeat (is gh logged in? run: gh auth login)"
  else warn "Heartbeat not installed"; fi
else
  echo "  (skipped: copy ~/trading-bot to this Mac first if you want Command Center to show it as Online)"
fi

# ---------- 6. trading bot (optional) ----------
step "6. Trading bot (paper trading, phone approvals)"
TB="$HOME/trading-bot/setup-mac-mini.sh"
if [ -f "$TB" ]; then
  if launchctl print "gui/$(id -u)/com.openverse.trader" >/dev/null 2>&1; then ok "Trader job is running (every 5 minutes)"
  elif ask "Set up the trading bot (Python env, phone alerts, 5-minute trader job, self-tests)?"; then
    bash "$TB" --bot-only && ok "Trading bot set up" || warn "Trading bot setup reported a problem (see above)"
  else warn "Trading bot not set up"; fi
else
  echo "  (skipped: ~/trading-bot isn't on this Mac. Copy it from your MacBook; it holds private keys, so it's never in GitHub)"
fi

# ---------- summary ----------
step "Summary"
left=(); for t in "${TODO[@]}"; do [ -n "$t" ] && left+=("$t"); done
if [ "${#left[@]}" = 0 ]; then echo "  ${G}All set.${N} Test it: unplug the power, plug it back in, and after ~2 minutes run from your MacBook:"
else echo "  Still to do:"; for t in "${left[@]}"; do echo "   • $t"; done; echo; echo "  Then test it: unplug the power, plug it back in, and after ~2 minutes run from your MacBook:"; fi
echo "    ssh $(whoami)@$(scutil --get LocalHostName 2>/dev/null).local \"ollama list\""
[ "$MODE" = check ] && echo && echo "  (check mode: nothing was changed)"
exit 0
