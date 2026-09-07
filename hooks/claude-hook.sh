#!/bin/sh
# Claude Code hook 진입점. hive install이 이 파일의 절대경로를 settings.json에 등록한다.
# stdout에 붙는 텍스트는 UserPromptSubmit/SessionStart에서 컨텍스트로 들어가므로 반드시 "{}"만 찍는다.
printf '{}\n'

[ -n "$DEVIN_PROJECT_DIR" ] && exit 0
[ -n "$CLAUDE_JOB_DIR" ] && exit 0

payload=$(cat)
[ -n "$payload" ] || exit 0

dir="${HIVE_HOME:-$HOME/.hive}/spool"
mkdir -p "$dir" 2>/dev/null || exit 0

pane=$(printf %s "${TMUX_PANE:-nopane}" | tr -c 'A-Za-z0-9_' '_')
f="$dir/pane-$pane.jsonl"

# 5MB 넘으면 비운다. offset 되돌림은 hive 쪽 ingest가 stat으로 감지한다.
if [ -f "$f" ] && [ "$(wc -c < "$f")" -gt 5242880 ]; then : > "$f"; fi

now=$(date +%s%N 2>/dev/null); now=$(printf %s "$now" | cut -c1-13)
esc() { printf %s "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# 서브에이전트 hook이 같은 파일에 동시에 쓸 수 있어 flock으로 직렬화한다.
# `{ flock 9; ...; } 9>>"$f"` 형태(그룹 명령에 붙인 리다이렉트)는 이 dash에서 fd가 파일로 안 가고
# stdout으로 새는 경우가 있어(실측), exec로 fd를 먼저 연 뒤 flock/printf를 개별 명령으로 실행한다.
exec 9>>"$f" 2>/dev/null
flock 9 2>/dev/null
printf '{"v":1,"ts":%s,"pane":"%s","tmux":"%s","payload":%s}\n' "$now" "$(esc "${TMUX_PANE:-}")" "$(esc "${TMUX:-}")" "$payload" >&9 2>/dev/null
exit 0
