#!/bin/sh
# hive 스풀 기록기. 첫 인자로 agent 이름(claude|codex)을 받는다.
# stdout 규약이 에이전트마다 달라서 진입점은 claude-hook.sh / codex-hook.sh로 나누고,
# stdin(payload)을 그대로 넘겨 이 스크립트를 exec한다.
agent="${1:-claude}"

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
#
# 서브셸로 감싸는 이유: exec에 붙은 리다이렉트가 실패하면 dash는 그 자리에서 종료하고 종료 코드가 2가 된다.
# `2>/dev/null`은 fd 9를 여는 도중 중단되므로 적용되기 전이고, `|| exit 0`도 exec가 특수 빌트인이라 안 걸린다.
# Claude Code는 hook의 exit 2를 blocking error로 해석하므로 스풀을 못 여는 순간 세션이 막힌다.
# 서브셸 안에서 죽으면 종료는 서브셸까지만이고 stderr는 서브셸에만 리다이렉트된다.
# flock에 -w를 주는 것도 같은 이유다. 락을 못 잡고 무한 대기하면 hook timeout까지 세션이 멈춘다.
(
  exec 9>>"$f"
  flock -w 1 9 2>/dev/null
  printf '{"v":1,"ts":%s,"agent":"%s","pane":"%s","tmux":"%s","payload":%s}\n' "$now" "$(esc "$agent")" "$(esc "${TMUX_PANE:-}")" "$(esc "${TMUX:-}")" "$payload" >&9
) 2>/dev/null
exit 0
