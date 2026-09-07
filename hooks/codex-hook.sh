#!/bin/sh
# Codex CLI hook 진입점. hive hook install이 이 파일의 절대경로를 ~/.codex/hooks.json에 등록한다.
# codex는 hook stdout을 hookSpecificOutput으로 파싱하므로 아무것도 찍지 않는다(빈 출력은 무시된다).
exec "$(dirname "$0")/agent-hook.sh" codex
