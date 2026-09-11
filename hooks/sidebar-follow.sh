#!/bin/sh
set -eu

socket=$1
sidebar=$2
target=$3
width=$4

tm() { tmux -S "$socket" "$@"; }
layout() { tm display-message -p -t "$1" '#{window_layout}'; }
first_pane() { tm list-panes -t "$1" -F '#{pane_id}' | head -n 1; }

# 프로세스가 중단돼도 해제되는 파일 잠금을 쓴다. 포커스와 창 전환의 배치 저장이 섞이면 안 된다.
exec 9>"$socket.hive-sidebar.lock"
flock -w 4 9

source=$(tm display-message -p -t "$sidebar" '#{window_id}')
target=$(tm display-message -p -t "$target" '#{window_id}')
[ "$source" != "$target" ] || exit 0
first=$(first_pane "$target")
before=$(layout "$target")
saved=$(tm show-options -wqv -t "$target" @hive_sidebar_layout)
without=$(tm show-options -wqv -t "$target" @hive_sidebar_without)

# 예전 hook으로 사이드바가 중간에 끼어든 배치는 복원 대상으로 삼지 않는다.
canonical=$(tm display-message -p -t "$sidebar" '#{pane_left}:#{pane_top}:#{pane_height}')
source_layout=
if [ "$(first_pane "$source")" = "$sidebar" ]; then
  height=$(tm display-message -p -t "$sidebar" '#{window_height}')
  top=0
  case $(tm display-message -p -t "$sidebar" '#{pane-border-status}') in
    top) top=1; height=$((height - 1)) ;;
    bottom) height=$((height - 1)) ;;
  esac
  if [ "$canonical" = "0:$top:$height" ]; then
    source_layout=$(layout "$source")
  fi
fi

# -f는 창 전체 높이를 쓰고, 첫 pane을 지정해야 pane 번호 순서도 왼쪽부터 유지된다.
tm join-pane -d -fhb -l "$width" -s "$sidebar" -t "$first"
if tm list-panes -t "$source" >/dev/null 2>&1; then
  tm set-option -w -t "$source" @hive_sidebar_layout "$source_layout"
  tm set-option -w -t "$source" @hive_sidebar_without "$(layout "$source")"
fi

# 사용자가 사이드바 없는 동안 pane을 나누거나 크기를 바꿨으면 그 변경을 유지한다.
if [ -n "$saved" ] && [ "$before" = "$without" ]; then
  tm select-layout -t "$target" "$saved" >/dev/null
fi
