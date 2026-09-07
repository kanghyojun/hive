#!/bin/sh
# Claude Code hook 진입점. hive hook install이 이 파일의 절대경로를 settings.json에 등록한다.
# stdout에 붙는 텍스트는 UserPromptSubmit/SessionStart에서 컨텍스트로 들어가므로 반드시 "{}"만 찍는다.
printf '{}\n'

# stdin(payload)은 그대로 넘어간다.
exec "$(dirname "$0")/agent-hook.sh" claude
