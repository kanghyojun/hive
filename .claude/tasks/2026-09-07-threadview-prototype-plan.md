# hive 쓰레드뷰 프로토타입 구현 계획

## 목표

`/home/ed/src/hive`에 TypeScript + Ink 기반 CLI `hive`를 만들어 다음이 tmux 위에서 실제로 동작하면 완료입니다.

1. `hive sidebar toggle`로 현재 tmux window 왼쪽에 34칸짜리 쓰레드뷰 pane이 붙었다 떼어집니다.
2. 쓰레드뷰는 현재 tmux 서버의 모든 window를 나열하고, Claude Code가 돌고 있는 window의 상태(working / waiting / done / idle / unknown)를 hook 이벤트 기반으로 보여줍니다.
3. 쓰레드뷰에서 j/k 이동 후 Enter, 또는 마우스 클릭으로 해당 window로 이동하며, 쓰레드뷰 pane이 그 window로 따라옵니다.
4. `s` 키로 window를 sleep 처리하면 어둡게(dimColor) 표시되고 목록 맨 아래로 내려갑니다.
5. `g` 키로 worktree별 그룹 보기와 최근 입력순 보기를 전환합니다.
6. `hive wt new <branch>`가 `HIVE_WORKTREE_BASE` 아래에 git worktree를 만들고, init script를 실행하고, 새 tmux window(좌 쓰레드뷰 / 우 터미널)를 엽니다.
7. `hive hook install --settings <path>`가 Claude Code settings.json에 hook을 백업 후 멱등적으로 추가하고, `uninstall`이 우리 hook만 제거합니다.
8. `hive wt init-script`가 저장소에 `.hive/init.sh` 템플릿을 만들고, 그 뒤 `wt new`가 그 스크립트를 자동 실행합니다.
9. `pnpm typecheck`, `pnpm test`, `pnpm build`가 통과합니다.

## 범위 밖

- codex 감지, transcript tail, OSC 타이틀 파싱, 알림, 원격 접근, 멀티 머신 동기화, 테마 시스템, CI, 배포.
- **`/home/ed/.tmux.conf`와 `/home/ed/.claude/settings.json`을 구현 중에 수정하는 것.** hook 설치는 사용자가 직접 `hive hook install`을 실행합니다. 구현 에이전트는 이 두 파일을 읽기만 하고 절대 쓰지 않습니다. 테스트는 `--settings <스크래치 경로>`로 격리합니다.
- 사용자의 실제 tmux 서버(기본 소켓 `/tmp/tmux-1001/default`, 세션 `0`)에서 window/pane을 만들거나 옵션·hook을 바꾸는 것. 구현 중 tmux 실험은 반드시 `tmux -L hivetest -f /dev/null ...`처럼 별도 소켓에서 하고 끝나면 `tmux -L hivetest kill-server`로 정리합니다.
- tmux를 실제로 띄우는 자동 통합 테스트. 순수 로직(reducer, 스풀 파싱, 정렬/그룹핑, settings 편집)만 vitest로 테스트합니다.
- 다른 tmux 세션으로의 자동 사이드바 이동(리스크 항목 참고).

## 현황

아래는 전부 이 머신에서 직접 실행해 확인한 사실입니다. 사용자 세션에 영향을 주는 실험은 `tmux -L hiveplan` 격리 서버에서 했고 이미 정리했습니다.

### 환경

- tmux 3.5a, node v22.19.0, pnpm 10.16.1, git 2.39.5, `/usr/bin/flock` 있음, GNU `date +%s%N` 동작.
- `/home/ed/src/hive`: `README.md` 하나, 커밋 `8acd744 init commit`, 브랜치 `feature/threadview-prototype`. `/home/ed/.hive`는 없음(우리가 만들 데이터 디렉토리와 충돌 없음).
- 사용자 tmux 전역 옵션(읽기 전용 확인): `mouse on`, `base-index 1`, `pane-base-index 1`, `status-position top`, `focus-events on`, `allow-passthrough on`, `default-terminal tmux-256color`. 전역 hook은 하나도 설정돼 있지 않음(`tmux show-hooks -g`에 값 있는 항목 없음).
- 사용자 root 키테이블 마우스 바인딩은 tmux 기본값 그대로입니다.
  ```
  bind-key -T root MouseDown1Pane    select-pane -t = \; send-keys -M
  bind-key -T root MouseDown1Status  select-window -t =
  bind-key -T root WheelUpPane       if-shell -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" { send-keys -M } { copy-mode -e }
  ```

### tmux 동작 (격리 서버에서 검증)

- **pane id, window id는 재사용되지 않습니다.** `%2`를 kill 후 split하면 `%3`, `@1`을 kill 후 new-window하면 `@3`이 나왔습니다. 단 서버가 재시작되면 `@0`, `%0`부터 다시 시작합니다. 서버 식별은 `#{pid}`(서버 PID)와 `#{start_time}`(서버 시작 시각, 예 `1788776164`)로 가능합니다.
- `tmux display-message -p -t %2 '#{window_id} #{window_index} #{session_name}'` → `@1 1 exp`. pane id로 window 역추적이 됩니다. 단 **없는 pane id를 `-t`로 주면 에러 없이 빈 문자열이 나옵니다**(`-t %99` → rc=0, 출력 빈칸). 존재 확인은 `tmux list-panes -a -F '#{pane_id}'` 목록과 비교해야 합니다.
- `split-window -hb -l 34 -d -P -F '#{pane_id}' -t @0 '<cmd>'`는 왼쪽 34칸 pane을 만들고 새 pane id를 출력하며, `-d` 때문에 포커스는 원래 pane에 남습니다(`%3 left=0 w=34 active=0 / %0 left=35 w=165 active=1`).
- `join-pane -d -hb -l 34 -s %3 -t @2`로 pane을 다른 window 왼쪽으로 옮길 수 있고 포커스는 대상 window의 기존 pane에 남습니다.
- 존재하는 hook 이름은 `tmux show-hooks -g`로 확인했습니다. 이번에 쓰는 것은 `session-window-changed`(세션의 활성 window가 바뀔 때)와 `command-error`입니다. `after-select-window`도 있지만 `next-window` 등 다른 경로를 못 잡으므로 쓰지 않습니다. 존재하지 않는 이름(`bogus-hook`)은 `invalid option`으로 거부됩니다.
- `session-window-changed`는 `select-window`, `next-window` 모두에서 발화했고, 같은 window를 다시 select하면 발화하지 않았습니다.
- hook은 배열 인덱스로 설정/해제할 수 있습니다: `set-hook -t <session> 'session-window-changed[77]' '<cmd>'`, `set-hook -u -t <session> 'session-window-changed[77]'`. 인덱스를 쓰면 다른 hook을 덮어쓰지 않습니다.
- **hook 안에서 `join-pane`을 직접 쓰면 동작하지 않았습니다**(에러도 없이 아무 일도 안 일어남). `run-shell`로 tmux 클라이언트를 다시 호출하면 동작합니다. 최종 검증된 형태:
  ```
  set-hook -t <session> 'session-window-changed[77]' "run-shell -b \"tmux -S '#{socket_path}' join-pane -d -hb -l 34 -s '#{@hive_sidebar_pane}' -t '#{window_id}' >/dev/null 2>&1\""
  ```
  `select-window -t @1` 후 사이드바 pane `%2`가 `@1`의 왼쪽(left=0, active=0)으로 옮겨졌습니다. 사이드바 id가 죽은 pane(`%99`)을 가리켜도 에러가 삼켜져 아무 일도 없습니다.
- run-shell 문자열 안에서 `#{session_id}`는 `$0`으로 펼쳐진 뒤 sh가 `$0`을 해석해 `sh`가 됩니다. **run-shell 안에서 `#{session_id}`, `#{pane_id}`처럼 `$`/`%`가 들어가는 값은 반드시 작은따옴표로 감싸고, 가능하면 session은 이름(`#{session_name}`)으로 다룹니다.**
- 사용자 옵션(`@이름`)은 세션(`set-option -t exp @hive_sidebar_pane %3`), window(`set-option -w -t @2 @hive_sleep 1`), 전역 모두 동작하고 `#{@hive_sidebar_pane}`로 읽힙니다. 설정 안 된 window에서는 빈 문자열입니다.
- `#{window_activity}`는 epoch 초이며 pane에 실제 출력이 생기면 갱신됩니다(`send-keys 'echo hello' Enter` 후 1788780825 → 1788780826). run-shell 출력으로는 갱신되지 않습니다.
- `new-window -P -F '#{window_id}' -n feat-x -c <path> '<cmd>'` → `@1` 출력, `#{window_name}=feat-x`, `#{pane_current_path}=<path>`, 활성 window가 됩니다.
- `list-panes -a -F ...`와 `list-windows -a -F ...`로 모든 세션의 pane/window를 한 번에 가져올 수 있고 `#{session_name} #{session_id} #{window_id} #{window_name} #{window_active} #{pane_current_path} #{pane_current_command} #{pane_id} #{pane_pid}` 전부 동작합니다.
- 마우스: `mouse on` 상태에서 pane 안 앱이 `\x1b[?1000;1006h`를 쓰면 tmux의 `#{mouse_any_flag}=1 #{mouse_sgr_flag}=1`이 됩니다. 기본 바인딩 `MouseDown1Pane → select-pane -t = ; send-keys -M`이 그 이벤트를 pane으로 전달합니다. `pane-focus-in` hook은 `focus-events on`일 때 동작(man).
- `command-prompt -p "..." "template"`에서 `%%`가 입력값으로 치환됩니다(man tmux). `{left-of}` pane 토큰도 있습니다.

### 이 세션(실제 Claude Code)에서 확인한 hook 귀속 근거

- 이 Claude Code의 Bash에서 `echo $TMUX_PANE` → `%0`, `$TMUX` → `/tmp/tmux-1001/default,1986967,0`(소켓 경로, 서버 PID, 클라이언트 인덱스).
- claude 프로세스 자체의 환경(`/proc/$CLAUDE_PID/environ`)에 `TMUX_PANE=%0`, `TMUX=/tmp/tmux-1001/default,1986967,0`이 있습니다. hook 프로세스는 이 프로세스의 자식이므로 같은 값을 상속합니다. 공식 문서도 hook에 "Standard parent process environment"가 전달된다고 명시합니다.
- `tmux display-message -p -t $TMUX_PANE '#{pane_current_command}'` → `claude`. hook 없는 상황에서도 pane에 claude가 떠 있는지는 알 수 있습니다.
- `#{pid}=1986967 #{start_time}=1788776164 #{socket_path}=/tmp/tmux-1001/default #{session_id}=$0`.

### Claude Code hook (공식 문서 https://code.claude.com/docs/en/hooks, 로컬 settings.json)

- 공통 입력 필드: `session_id`, `prompt_id`, `transcript_path`, `cwd`, `permission_mode`, `effort`, `hook_event_name`, (서브에이전트만) `agent_id`, `agent_type`.
- 이벤트별: `SessionStart.source`(startup/resume/clear/compact/fork), `SessionEnd.reason`(clear/resume/logout/prompt_input_exit/other), `UserPromptSubmit.prompt`, `PreToolUse.tool_name/tool_input/tool_use_id`, `PostToolUse.+tool_output`, `PostToolUseFailure.+tool_error`, `PermissionRequest.tool_name/tool_input/permission_prompt`, `Stop.last_assistant_message`, `StopFailure.error_type/error_message`, `SubagentStart/Stop.agent_type/agent_id`, `TeammateIdle.agent_type`, `PostCompact.trigger`(manual/auto), `Notification`은 matcher가 `notification_type`(permission_prompt, idle_prompt, ...)이며 입력 필드 스키마는 문서에 없음.
- `is_interrupt`, `background_tasks` 같은 orca가 언급한 필드는 문서에 없습니다. 페이로드는 통째로 저장하고 필드는 방어적으로 읽습니다.
- settings 구조: `hooks.<Event>[] = { matcher?, hooks: [{type:"command", command, timeout?, async?}] }`. matcher `"*"`/생략은 전부 매치. 같은 이벤트의 여러 hook은 병렬 실행되고 여러 파일의 hook은 병합됩니다. exit 0이면 stdout은 대부분 debug 로그로만 갑니다(`UserPromptSubmit`/`SessionStart`는 stdout 텍스트가 컨텍스트에 붙으므로 `{}`만 출력). hook 실행 디렉토리는 현재 디렉토리이며 stdin으로 JSON이 옵니다.
- settings 문서: "Claude Code watches your settings files and reloads them when they change ... including edits to `hooks`". `CLAUDE_CONFIG_DIR`을 설정하면 settings, 세션 기록, 플러그인이 그 디렉토리에 저장됩니다. `claude --settings <file-or-json>`도 있습니다.
- 사용자의 `/home/ed/.claude/settings.json`에는 이미 orca hook(`~/.orca/agent-hooks/claude-hook.sh`, 13개 이벤트)과 `curl ... 127.0.0.1:47100/event?agent=claude`(UserPromptSubmit/PreToolUse/PostToolUse/Stop/Notification 3종)가 공존합니다. `Notification`은 `permission_prompt`, `idle_prompt`, `elicitation_dialog` matcher로 3개 항목이 있습니다.
- Claude 실행 파일(`/home/ed/.local/share/claude/versions/2.1.263`)에서 문자열 존재 확인: `Do you want to proceed`(6), `Yes, and don't ask again`(8), `Allow once`(2), `Esc to cancel`(7), `Press Enter to continue`(1). 승인 프롬프트 화면 정규식은 이 중에서 고릅니다.
- orca hook 스크립트(`/home/ed/.orca/agent-hooks/claude-hook.sh`)의 실전 디테일: 맨 먼저 `printf "{}\n"`, `payload=$({ command -p cat 2>/dev/null || cat; })`, 스풀 5MB 초과 시 쓰기 중단, 7일 지난 파일 truncate, `DEVIN_PROJECT_DIR`/`CLAUDE_JOB_DIR` 있으면 종료.

### hook 스크립트 프로토타입 검증

아래 sh 스크립트를 `HIVE_HOME=<scratch> TMUX_PANE='%7' TMUX='/tmp/tmux-1001/default,1986967,0'`로 실행하니 `spool/pane-_7.jsonl`에 한 줄이 붙었고 python json.loads로 파싱됐습니다. 20회 실행 0.134초(회당 약 7ms).

```sh
#!/bin/sh
printf '{}\n'
payload=$(cat)
[ -n "$payload" ] || exit 0
dir="${HIVE_HOME:-$HOME/.hive}/spool"
mkdir -p "$dir" 2>/dev/null || exit 0
pane=$(printf %s "${TMUX_PANE:-nopane}" | tr -c 'A-Za-z0-9_' '_' )
f="$dir/pane-$pane.jsonl"
if [ -f "$f" ] && [ "$(wc -c < "$f")" -gt 5242880 ]; then : > "$f"; fi
now=$(date +%s%N 2>/dev/null); now=$(printf %s "$now" | cut -c1-13)
esc() { printf %s "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
{ flock 9; printf '{"v":1,"ts":%s,"pane":"%s","tmux":"%s","payload":%s}\n' "$now" "$(esc "${TMUX_PANE:-}")" "$(esc "${TMUX:-}")" "$payload"; } 9>>"$f" 2>/dev/null || :
exit 0
```

출력 예: `{"v":1,"ts":1788781121659,"pane":"%7","tmux":"/tmp/tmux-1001/default,1986967,0","payload":{...}}`

### Node / npm 패키지

- `node:sqlite`는 node 22.19.0에 있습니다. `DatabaseSync`, `StatementSync` export. 파일 DB에서 `pragma journal_mode=wal` → `wal`, `pragma busy_timeout=3000` 동작, `INSERT OR IGNORE` + UNIQUE로 중복 삽입 시 `changes: 0`. 로드 시 `ExperimentalWarning: SQLite is an experimental feature`가 stderr에 찍힙니다. ESM에서 정적 import 전에 `process.emitWarning`을 바꿔도 못 막지만, **`process.removeAllListeners('warning')` + 필터 리스너 등록 후 `await import('node:sqlite')`(동적 import)** 하면 조용합니다. `node --disable-warning=ExperimentalWarning`도 동작합니다.
- `ink@7.1.1`(engines node>=22, peer `react>=19.2.0`, `@types/react`와 `react-devtools-core`는 optional), `react@19.2.8`, `vitest@5.0.0`(engines `^22.12.0 || ^24 || >=26`, 설치·실행 확인), `tsx@4.23.13`(실행 확인), `typescript@7.0.2`, `@types/node@26.4.1`, `commander@15.0.0`. `better-sqlite3@13.0.3`는 네이티브 빌드가 필요해 쓰지 않습니다.
- **TypeScript 7.0.2(native 포팅 버전)로 ink 7 + react 19 JSX가 실제로 빌드됩니다.** 스크래치 디렉토리에서 `ink@^7.1.1 react@^19.2.0 typescript@^7 @types/react@^19 @types/node@^26`를 pnpm으로 설치하고, `module NodeNext / jsx react-jsx / strict` tsconfig로 `Box`, `Text dimColor`, `useInput`을 쓰는 `.tsx`를 `tsc -p`로 컴파일해 rc=0과 `dist/a.js` 생성을 확인했습니다. `typescript@latest`가 7.0.2입니다.
- **ink 7은 `"type": "module"`이 아닌 패키지에서 tsx로 실행하면 실패합니다.** 에러: `yoga-layout/dist/src/index.js: Top-level await is currently not supported with the "cjs" output format`. package.json에 `"type": "module"`을 넣으니 정상 동작했습니다.
- ink 7 export 확인: `render, Box, Text, Static, useInput, useStdin, useStdout, useApp, useFocus, useWindowSize, measureElement`. `Text`에 `dimColor`, `inverse`, `bold`, `backgroundColor`, `wrap` prop 있음. `useStdin()`은 `{stdin, setRawMode, isRawModeSupported}`. `useInput`은 활성화 시 `setRawMode(true)`를 호출합니다. `render` 옵션에 `exitOnCtrlC`, `patchConsole` 있음.
- ink의 `parseKeypress`에 SGR 마우스 시퀀스를 넣으면 `name: ""`, `sequence` 그대로가 나오고, `useInput` 콜백에는 ESC가 벗겨진 `"[<0;12;5M"` 문자열로 들어옵니다(실측). 즉 마우스는 `useStdin().stdin.on('data')`로 직접 파싱하고 `useInput`에서는 `[<`로 시작하는 입력을 무시하면 됩니다.
- 격리 tmux pane에서 ink 스모크 앱(`Box borderStyle`, `Text dimColor/inverse`, `useInput`, SGR 마우스 켜기)을 tsx로 띄운 결과: 화면이 정상 렌더됐고, `send-keys j / Up / Enter`가 `useInput`에 `"j"`, `upArrow`, `return`으로 들어왔으며, `send-keys -l $'\e[<0;12;5M'`로 넣은 SGR 시퀀스가 stdin 리스너에서 `btn=0 col=12 row=5`로 파싱됐습니다. 이때 tmux `#{mouse_sgr_flag}=1`.

### git worktree 판별

- worktree 디렉토리에서 `git rev-parse --show-toplevel --git-common-dir --abbrev-ref HEAD` 한 번에 세 줄이 나옵니다:
  `/home/ed/src/vscode-git.worktrees/diff-view`, `/home/ed/src/vscode-git/.git`, `another-main`.
- 주 저장소에서는 common-dir이 상대경로 `.git`으로 나옵니다(`/home/ed/src/vscode-git`, `.git`, `main`). `path.resolve(toplevel, commonDir)`로 절대화한 뒤 `dirname`을 저장소 키로 씁니다.
- git 저장소가 아니면 rc=128.
- `git worktree list --porcelain`은 `worktree <path> / HEAD <sha> / branch refs/heads/<name>` 블록을 빈 줄로 구분해 출력합니다.
- `git worktree add [-b <new-branch>] <path> [<commit-ish>]`.
- 사용자 workpad 설정: `worktreeBase: "{repoParent}/{repo}-worktrees"`. 실제로 `~/src/vscode-git.worktrees`, `~/src/worktrees` 등이 있습니다.

## 설계 결정

### 1. 왼쪽 pane 토글: (a)+(c) 조합, "하나의 사이드바 pane이 사용자를 따라다닌다"

- 주 경로: `hive sidebar show`가 현재 window에 `split-window -hb -l 34 -d -P -F '#{pane_id}' '<node> <cli.js> tui'`로 pane 하나를 만들고, pane id를 세션 옵션 `@hive_sidebar_pane`에 저장하고, 세션 hook `session-window-changed[77]`에 위 "현황"에서 검증한 `run-shell -b "tmux -S '#{socket_path}' join-pane -d -hb -l 34 -s '#{@hive_sidebar_pane}' -t '#{window_id}' >/dev/null 2>&1"`을 겁니다. 사용자가 어떤 방법으로든 window를 바꾸면 tmux가 사이드바 pane을 그 window 왼쪽으로 옮깁니다. TUI 프로세스는 하나만 살아 있고 상태를 잃지 않습니다.
- `hive sidebar hide`: 옵션에 저장된 pane을 `kill-pane`, `set-hook -u ... [77]`, `set-option -u -t <session> @hive_sidebar_pane`. `toggle`은 옵션 유무로 분기. TUI가 `q`로 끝날 때도 같은 정리를 스스로 합니다.
- 버린 것: (b) `display-popup`은 man에 "Panes are not updated while a popup is present"라고 명시돼 있어 상시 표시에 부적합합니다. 순수 (a)만 쓰면 window를 옮길 때마다 사라지고, window마다 새로 띄우면 node 기동(수십 ms)과 상태 손실이 생깁니다. hook 안에서 `join-pane`을 직접 쓰는 방식은 실험에서 동작하지 않아 `run-shell` 래퍼로 갑니다.
- node 없이 순수 tmux 명령으로 따라다니게 해서 window 전환 지연이 없습니다.

### 2. 탭 선택 후 쓰레드뷰가 사라지는 문제

- 1번의 hook이 해결합니다. TUI는 `tmux select-window -t <window_id>`만 실행하고, 이동은 tmux hook이 `join-pane -d`로 처리합니다. `-d`라서 포커스는 대상 window의 원래 pane(claude가 떠 있는 곳)에 남습니다. 키보드로 사이드바에 다시 들어가려면 사용자의 기존 바인딩 `prefix+h`(`select-pane -L`)를 쓰면 됩니다. README에 안내합니다.
- 같은 window를 선택하면 hook이 발화하지 않으므로 무한 루프 없음(실측).

### 3. Ink 마우스

- 주 경로는 키보드(j/k/↑/↓, Enter, s, g, r, q)입니다.
- 마우스는 "사이드바 pane 안에서 왼쪽 버튼 클릭으로 탭 선택+이동, 휠로 선택 이동"까지만 지원합니다. 구현: 마운트 시 `stdout.write('\x1b[?1000;1006h')`, 언마운트 시 `l`로 끄기, `useStdin().stdin.on('data')`에서 `/\x1b\[<(\d+);(\d+);(\d+)([mM])/g`를 파싱해 `btn===0 && 'M'`이면 `row`를 목록 인덱스로 변환, `btn 64/65`는 휠. `useInput`에서는 `input.startsWith('[<')`이면 무시.
- 근거: 사용자 tmux는 `mouse on`이고 기본 `MouseDown1Pane` 바인딩이 `send-keys -M`으로 pane에 전달하며, 앱이 SGR을 켜면 tmux `mouse_sgr_flag=1`이 됩니다(실측). 파싱 경로는 격리 tmux에서 실측했습니다.
- 확인 필요: 실제 클릭에서 tmux가 전달하는 좌표가 pane 기준인지(정황상 그렇지만 사람이 클릭해서 확인). 클릭 좌표는 헤더 2줄(제목, 모드 표시)을 뺀 값으로 계산합니다. 창 바깥 클릭, 드래그, 더블클릭은 범위 밖입니다.

### 4. hook 이벤트의 tmux window 귀속

- hook 스크립트가 `$TMUX_PANE`(pane id)과 `$TMUX`(소켓 경로, 서버 PID)를 각 줄에 기록합니다. 근거: claude 프로세스 환경에 두 값이 있음을 `/proc/<pid>/environ`으로 확인했습니다.
- TUI는 이벤트를 pane 단위 상태(`agents` 테이블, 키 `(tmux_pid, pane_id)`)로 유지하고, 렌더 시 `tmux list-panes -a -F ...` 결과로 pane → window를 매핑합니다. pane id는 서버 수명 안에서 재사용되지 않습니다(실측). 서버 재시작 후 같은 id가 재등장하는 문제는 이벤트의 `tmux_pid`와 현재 `#{pid}`를 비교해 다른 서버의 이벤트를 무시하는 것으로 막습니다.
- `TMUX_PANE`이 없는 이벤트(popup, tmux 밖 실행)는 `pane="nopane"`으로 저장하고 화면에는 "tmux 밖" 묶음으로 한 줄만 표시합니다.

### 5. hook payload 스키마

- 문서에서 확인한 필드만 명시적으로 읽습니다: `hook_event_name`, `session_id`, `cwd`, `tool_name`, `tool_input`, `agent_id`, `agent_type`, `source`, `reason`, `trigger`, `prompt`, `permission_prompt`, `notification_type`. 나머지는 `payload` JSON 컬럼에 통째로 저장합니다. orca가 쓰는 `is_interrupt`, `background_tasks`는 문서에 없으므로 있으면 쓰고 없으면 무시하는 optional 처리만 합니다.
- 상태 매핑(orca 4상태 그대로, 단 blocked는 미사용):
  - `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, 일반 `PreToolUse` → working
  - `PermissionRequest`, `Notification(notification_type=permission_prompt|elicitation_dialog)`, `PreToolUse`인데 `tool_name`을 `[^a-z0-9]` 제거·소문자화한 값이 `askuserquestion` 또는 `requestuserinput` → waiting (질문 텍스트는 `tool_input.question` 또는 `tool_input.questions[0].question`이 있으면 보관, 없으면 `permission_prompt`)
  - `Stop`, `StopFailure`, `PostCompact(trigger=manual)` → done. 단 서브에이전트 로스터에 working이 남아 있으면 working 유지.
  - `SessionStart` → 로스터 리셋, done. `SessionEnd` → ended(화면에는 idle로 접힘).
  - `SubagentStart` → 로스터에 agent_id 추가(working), `SubagentStop`/`TeammateIdle` → 제거.
  - 마지막 이벤트로부터 30분 경과 → idle(orca와 동일).
  - hook 이벤트가 하나도 없는데 `pane_current_command`가 `claude`면 unknown(`?`), 그 외는 agent 없음.
- 화면 텍스트 폴백: `pane_current_command === 'claude'`인 pane에 대해 3초마다 `tmux capture-pane -p -t <pane> | tail -n 25`를 읽어 `/Do you want to proceed\?/` 또는 `/Yes, and don't ask again/`이 보이면 waiting(source=screen)으로 덮어씁니다. 두 정규식은 실행 파일 문자열로 존재를 확인했습니다. 사라지면 hook 상태로 되돌립니다.

### 6. hook 등록

- `hive hook install [--settings <path>] [--dry-run]`, `hive hook uninstall [--settings <path>]`, `hive hook status [--settings <path>]`. 기본 경로는 `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json`(문서 확인). 테스트와 검증에서는 항상 `--settings <스크래치 경로>`를 씁니다.
- 설치 로직은 순수 함수 `applyHiveHooks(settings: object, scriptPath: string): object`로 분리해 vitest로 검증합니다. 이벤트 14개: `SessionStart, SessionEnd, UserPromptSubmit, PreToolUse(*), PostToolUse(*), PostToolUseFailure(*), PermissionRequest(*), Notification, Stop, StopFailure, SubagentStart, SubagentStop, TeammateIdle, PostCompact`. 각 이벤트 배열에 `{ matcher: "*"(툴 이벤트만), hooks: [{ type: "command", command: "<hook.sh 절대경로>", timeout: 5 }] }`를 추가하되, 이미 같은 `command` 문자열을 가진 hook이 그 이벤트에 있으면 건너뜁니다(멱등). uninstall은 `command`가 우리 스크립트 경로와 정확히 같은 항목만 제거하고, 비게 된 matcher 그룹과 이벤트 배열만 정리합니다. 다른 hook(orca, curl)은 손대지 않습니다.
- 쓰기 전 `settings.json.hive-backup-<ISO시각>` 백업을 같은 디렉토리에 남깁니다. JSON은 `JSON.stringify(obj, null, 2)`로 씁니다(주석 없는 JSON임을 로컬 파일에서 확인).
- **구현 에이전트는 `hive hook install`을 실제 `~/.claude/settings.json`에 실행하지 않습니다.** README에 사용자가 직접 실행하도록 적습니다. 문서상 settings 변경은 자동 reload되므로 재시작이 필수는 아니지만, 확실하려면 새 claude 세션에서 확인하라고 적습니다.

### 7. worktree 판별과 그룹핑

- `src/git.ts`에 `resolveRepo(cwd)`: `git -C <cwd> rev-parse --show-toplevel --git-common-dir --abbrev-ref HEAD` 한 번 호출 → `{toplevel, repoRoot: dirname(resolve(toplevel, commonDir)), branch}`. rc 128이면 `null`.
- 캐시: `Map<cwd, {value, at}>` TTL 60초. 렌더 tick마다 `pane_current_path` 집합에 대해서만 조회하고, 캐시 미스일 때만 git을 부릅니다. 동기 `execFileSync`로 충분합니다(pane 수가 수십 개 수준).
- 그룹 키는 `repoRoot`(주 저장소 경로), 그 아래 worktree는 `toplevel`. 표시 이름은 `basename(repoRoot)` / `branch`.

### 8. 정렬 두 축

- `lastInputTs(window)` = 그 window의 pane들에 대한 `agents.last_prompt_ts`(UserPromptSubmit 시각) 최댓값. 없으면 `#{window_activity}*1000`을 폴백으로 씁니다(출력에 반응해 갱신되는 것을 실측). 폴백은 "활동"이지 "입력"이 아니므로 화면에 `~` 접두로 구분합니다.
- 모드 `recent`: `lastInputTs` 내림차순 단일 목록. 모드 `group`: repoRoot → worktree → window 순으로 묶고, 그룹 순서는 그룹 안 최댓값 내림차순. 두 모드 모두 sleep window는 맨 아래로 보냅니다. `g` 키로 전환, 마지막 모드는 `~/.hive/ui.json`에 저장.

### 9. sleep

- SQLite `window_flags(server_key TEXT, window_id TEXT, sleep INTEGER, PRIMARY KEY(server_key, window_id))`. `server_key = #{start_time}`(서버 재시작 시 id가 되돌아가는 문제 대응).
- 의미: **표시 전용**입니다. 이벤트 흡수와 상태 계산은 계속하고, 화면에서 `dimColor`로 어둡게 + 맨 아래 정렬 + 상태 아이콘 앞에 `z`를 붙입니다. waiting이 와도 dim 상태를 유지하되 아이콘은 보이게 합니다.
- 정리: 매 tick `list-windows -a`에 없는 window_id의 행과, `server_key != 현재 start_time`인 행을 삭제합니다.
- 버린 것: tmux window 옵션 `@hive_sleep`만으로 저장하는 안. window가 사라지면 자동 정리되는 장점이 있지만 이후 hive가 window 메모/별칭 등을 더 얹을 때 DB가 필요하므로 이번에 DB 경로를 만들어 둡니다.

### 10. worktree 생성 플로우

`hive wt new <branch> [--repo <path>] [--base <ref>] [--no-init]`:

1. repo 결정: `--repo` > 현재 `$PWD`의 `resolveRepo().repoRoot`. 없으면 에러.
2. 경로: `HIVE_WORKTREE_BASE`(기본 `{repoParent}/{repo}-worktrees`, 두 플레이스홀더 치환) + `/` + `branch.replaceAll('/', '-')`. 이미 있으면 에러.
3. `git -C <repo> worktree add -b <branch> <path> [<base>]`. 브랜치가 이미 있으면(`git rev-parse --verify refs/heads/<branch>` 성공) `-b` 없이 add.
4. init script 결정: `HIVE_INIT_SCRIPT` env(절대경로) > `<repo>/.hive/init.sh` > 없음. 둘 다 있으면 env 우선.
   - 스크립트를 **만드는** 쪽은 별도 커맨드입니다. `hive wt init-script [--repo <path>] [--force]`가 `<repo>/.hive/init.sh`를 템플릿으로 생성하고 `chmod +x` 합니다. 이미 있으면 건드리지 않고 경로만 알리며, `--force`일 때만 덮어씁니다. 템플릿 내용은 주석으로 사용법(작업 디렉토리는 새 worktree 경로, 실패해도 worktree는 유지됨)을 적고, 본문은 lock 파일이 있으면 설치를 돌리는 형태로 둡니다:
     ```sh
     #!/bin/sh
     # hive worktree init script. cwd = 새로 만들어진 worktree 경로.
     set -e
     [ -f pnpm-lock.yaml ] && pnpm install
     [ -f package-lock.json ] && npm ci
     [ -f uv.lock ] && uv sync
     exit 0
     ```
     `set -e`와 `[ ... ] && cmd`의 조합은 조건이 거짓일 때 마지막 명령의 exit code가 1이 되어 스크립트가 죽을 수 있으므로, 템플릿은 각 줄을 `if [ -f ... ]; then ...; fi` 형태로 씁니다.
5. tmux: `tmux new-window -P -F '#{window_id}' -n <branch> -c <path> "<node> <cli.js> wt run-init <path> [<script>]; exec ${SHELL:-sh}"`. `run-init`은 스크립트를 `sh <script>`로 cwd=<path>에서 stdio 파이프로 실행해 stdout/stderr를 화면과 `~/.hive/logs/wt-<safe-branch>.log`에 동시에 쓰고, 끝나면 `[hive] init exit=<code> (log: <경로>)`를 출력합니다. 스크립트가 없으면 `[hive] no init script`만 출력. 실패해도 worktree와 window는 유지하고 exit code만 알립니다.
6. 새 window가 활성이 되면서 hook이 사이드바를 왼쪽에 붙입니다. 사이드바가 없으면(`@hive_sidebar_pane` 미설정) `hive sidebar show`를 호출합니다. 결과: 좌 쓰레드뷰 / 우 init 로그가 흐른 뒤 셸.
7. tmux 밖에서 실행되면 3단계까지만 하고 경로를 출력합니다.

TUI에서는 `n` 키로 branch 이름을 한 줄 입력받아 선택된 window의 repo에 대해 같은 흐름을 실행합니다. tmux 바인딩은 README 스니펫으로만 제공합니다:

```
bind V run-shell -b "<node> <cli.js> sidebar toggle"
bind W command-prompt -p "branch:" "run-shell -b '<node> <cli.js> wt new %% --repo #{pane_current_path}'"
```

### 11. SQLite 동시성

- `node:sqlite` `DatabaseSync` 사용(확인됨). `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA synchronous=NORMAL`.
- `events(spool_file, spool_offset)`에 UNIQUE, `spool_offsets(spool_file PK, offset)`. 흡수는 파일마다 `BEGIN IMMEDIATE` 트랜잭션 하나: 저장된 offset부터 읽어 줄 단위 파싱 → `INSERT OR IGNORE` → `changes === 1`인 줄만 reducer에 적용해 `agents` upsert → offset 갱신 → COMMIT. IMMEDIATE 락으로 두 TUI가 동시에 같은 구간을 처리하지 못하므로 상태 이중 적용도 없습니다.
- 파일 크기가 저장된 offset보다 작으면(훅이 5MB 초과로 truncate) offset을 0으로 되돌립니다. 마지막 줄이 개행 없이 끝나면 다음 tick까지 미룹니다. JSON 파싱 실패 줄은 건너뛰고 카운트만 남깁니다.
- `ExperimentalWarning`은 `src/cli.ts` 첫 줄에서 `process.removeAllListeners('warning')` + 필터 리스너를 걸고 `src/db.ts`가 `await import('node:sqlite')`로 로드하는 방식으로 막습니다(실측).

### 그 외 결정

- 패키지는 ESM(`"type": "module"`) 필수(ink 7 실측). tsconfig `module: NodeNext`, `jsx: react-jsx`, `target: ES2022`, `strict`.
- 실행 경로: 개발은 `pnpm dev -- <args>`(= `tsx src/cli.tsx`), 빌드는 `tsc` → `dist/`, bin `hive` → `dist/cli.js`. **tmux에 넣는 모든 명령은 PATH에 의존하지 않고 `process.execPath`와 `fileURLToPath(import.meta.url)`로 구한 자기 자신의 절대경로를 씁니다**(run-shell은 tmux 서버 환경의 sh로 돌아 pnpm 전역 bin이 PATH에 없을 수 있음).
- tmux 소켓: `HIVE_TMUX_SOCKET` env가 있으면 `tmux -S <socket>`, 없으면 `$TMUX`의 첫 필드, 둘 다 없으면 기본 소켓. 모든 tmux 호출은 `src/tmux.ts`의 `tmux(args)` 한 함수를 거칩니다.
- 사이드바 폭 34칸(상수 `SIDEBAR_WIDTH`).
- 데이터 디렉토리 `HIVE_HOME`(기본 `~/.hive`): `hive.db`, `spool/`, `logs/`, `ui.json`.

## 변경 계획

### 1. `/home/ed/src/hive/package.json`
- `name: "hive"`, `private: true`, `"type": "module"`, `bin: {"hive": "./dist/cli.js"}`, `engines.node: ">=22.12"`.
- scripts: `dev: "tsx src/cli.tsx"`, `build: "tsc -p tsconfig.json"`, `typecheck: "tsc -p tsconfig.json --noEmit"`, `test: "vitest run"`.
- dependencies: `ink@^7.1.1`, `react@^19.2.0`, `commander@^15.0.0`. devDependencies: `typescript@^7`, `tsx@^4.23`, `vitest@^5`, `@types/node@^26`, `@types/react@^19`.
- `pnpm install`로 `pnpm-lock.yaml` 생성.

### 2. `/home/ed/src/hive/tsconfig.json`
- `compilerOptions`: `target ES2022`, `module NodeNext`, `moduleResolution NodeNext`, `jsx react-jsx`, `strict true`, `outDir dist`, `rootDir src`, `types ["node"]`, `skipLibCheck true`, `declaration false`. `include: ["src"]`, `exclude: ["src/**/*.test.ts"]`.

### 3. `/home/ed/src/hive/.gitignore`
- `node_modules/`, `dist/`, `*.log`.

### 4. `/home/ed/src/hive/hooks/claude-hook.sh`
- "현황"의 검증된 스크립트 그대로. 추가로 `DEVIN_PROJECT_DIR`/`CLAUDE_JOB_DIR`가 있으면 즉시 exit 0(orca와 동일). 실행 권한 `chmod +x`. `hook install`이 이 파일의 절대경로를 settings에 씁니다.

### 5. `/home/ed/src/hive/src/cli.tsx` (약 150줄)
- 첫 줄: `#!/usr/bin/env node`, 그 다음 warning 필터. commander로 커맨드 트리 구성:
  - `tui` → `runTui()`
  - `sidebar show|hide|toggle` → `src/sidebar.ts`
  - `hook install|uninstall|status [--settings <path>] [--dry-run]` → `src/hookInstall.ts`
  - `wt new <branch> [--repo] [--base] [--no-init]`, `wt run-init <path> [script]`, `wt init-script [--repo] [--force]`, `wt list` → `src/worktree.ts`
  - `ps [--json]` → DB에서 agents + tmux pane 매핑을 합쳐 출력(디버깅용, orca `worktree ps --json` 대응)
  - `ingest` → 스풀을 한 번 흡수하고 종료(테스트·디버깅용)
  - `paths` → execPath, cli.js, hook.sh, HIVE_HOME 절대경로 출력(README 스니펫 채우기용)
- 전역 옵션 `--home <dir>`(= HIVE_HOME 덮어쓰기), `--tmux-socket <path>`.

### 6. `/home/ed/src/hive/src/paths.ts` (약 60줄)
- `hiveHome()`, `dbPath()`, `spoolDir()`, `logsDir()`, `uiStatePath()`, `hookScriptPath()`(패키지 루트 `/hooks/claude-hook.sh`), `selfCommand()`(`[process.execPath, <cli.js 절대경로>]`), `ensureDirs()`.

### 7. `/home/ed/src/hive/src/tmux.ts` (약 200줄)
- `tmux(args: string[]): string` — `execFileSync('tmux', [...socketArgs, ...args])`. 실패 시 `TmuxError`.
- `insideTmux()`, `currentPaneId()`(`$TMUX_PANE`), `serverInfo()` → `{pid, startTime, socketPath}` (`display-message -p '#{pid} #{start_time} #{socket_path}'`).
- `listPanes()` → `PaneInfo[]`: `list-panes -a -F` 구분자 `\t`로 `session_name, session_id, window_id, window_index, window_name, window_active, window_activity, pane_id, pane_active, pane_current_path, pane_current_command, pane_pid`.
- `selectWindow(windowId)`, `capturePaneTail(paneId, lines)`, `newWindow({name, cwd, command})` → window id, `splitLeft({target, width, command})` → pane id, `paneExists(id)`(list-panes 비교), `getSessionOption(session, name)`, `setSessionOption`, `unsetSessionOption`, `setSessionHook(session, 'session-window-changed[77]', cmd)`, `unsetSessionHook`.
- session 대상은 항상 `session_name`을 씁니다(`$0` 문제 회피).

### 8. `/home/ed/src/hive/src/sidebar.ts` (약 120줄)
- `showSidebar()`: 현재 pane의 세션 이름/window 조회 → 이미 옵션이 있고 pane이 살아 있으면 no-op → `splitLeft` → `setSessionOption('@hive_sidebar_pane', id)` → `setSessionHook(... run-shell -b "tmux -S '#{socket_path}' join-pane ..." )`.
- `hideSidebar()`, `toggleSidebar()`, `cleanupFromTui()`(TUI 종료 시 hook/옵션 해제만).

### 9. `/home/ed/src/hive/src/db.ts` (약 150줄)
- `await import('node:sqlite')`. `openDb(path)` → WAL, busy_timeout, 스키마 생성:
  - `events(id INTEGER PK, spool_file TEXT, spool_offset INTEGER, ts INTEGER, tmux_pid INTEGER, pane_id TEXT, session_id TEXT, event TEXT, tool_name TEXT, payload TEXT, UNIQUE(spool_file, spool_offset))`
  - `spool_offsets(spool_file TEXT PK, offset INTEGER)`
  - `agents(tmux_pid INTEGER, pane_id TEXT, state TEXT, source TEXT, tool_name TEXT, prompt TEXT, last_event TEXT, last_ts INTEGER, last_prompt_ts INTEGER, subagents TEXT, ended INTEGER, PRIMARY KEY(tmux_pid, pane_id))`
  - `window_flags(server_key TEXT, window_id TEXT, sleep INTEGER, PRIMARY KEY(server_key, window_id))`
- 준비된 statement를 감싼 함수: `getOffset`, `setOffset`, `insertEvent`(changes 반환), `getAgent`, `upsertAgent`, `listAgents(tmuxPid)`, `getSleepMap(serverKey)`, `setSleep`, `pruneWindowFlags(serverKey, liveWindowIds)`, `transaction(fn)`(BEGIN IMMEDIATE/COMMIT/ROLLBACK).

### 10. `/home/ed/src/hive/src/spool.ts` (약 120줄)
- 순수: `parseSpoolLine(line): SpoolRecord | null`(`{v, ts, pane, tmux, payload}` 검증, `tmux` 문자열에서 `socket`, `serverPid` 추출), `splitCompleteLines(buf, startOffset): {lines: {offset, text}[], nextOffset}`.
- IO: `ingestAll(db, spoolDir, reducer)`: 파일마다 stat → offset 비교(truncate 감지) → 새 구간 읽기 → 트랜잭션 안에서 파싱·삽입·reducer 적용·offset 갱신. 반환 `{inserted, skipped}`.

### 11. `/home/ed/src/hive/src/state.ts` (약 150줄)
- 타입 `AgentState = 'working'|'waiting'|'done'|'idle'|'unknown'`, `AgentRecord`.
- 순수 `reduceAgent(prev: AgentRecord | undefined, ev: {ts, event, payload}): AgentRecord` — 설계 결정 5의 매핑. 서브에이전트 로스터는 `subagents: Record<agentId, 'working'>`.
- 순수 `effectiveState(rec, now, screenWaiting: boolean): {state, source}` — ended → idle, 30분 경과 → idle, screenWaiting이면 waiting/screen.
- 순수 `normalizeToolName(name)`, `isInteractiveTool(name)`, `PERMISSION_PATTERNS = [/Do you want to proceed\?/, /Yes, and don't ask again/]`, `looksLikePermissionPrompt(text)`.

### 12. `/home/ed/src/hive/src/git.ts` (약 100줄)
- `resolveRepo(cwd): RepoInfo | null`(캐시 TTL 60초), `listWorktrees(repoRoot)`(porcelain 파싱), `worktreeAdd({repoRoot, branch, path, base})`, `branchExists(repoRoot, branch)`, `worktreeBasePath(repoRoot)`(`HIVE_WORKTREE_BASE` 플레이스홀더 치환).

### 13. `/home/ed/src/hive/src/worktree.ts` (약 130줄)
- `wtNew(opts)` 설계 결정 10의 1~7단계. `wtRunInit(path, script?)`: `spawn('sh', [script], {cwd: path})` stdout/stderr를 `process.stdout`와 로그 파일 스트림에 동시 기록, 종료 코드 출력, 그 코드로 exit. `findInitScript(repoRoot)`. `createInitScript({repoRoot, force})`: `<repoRoot>/.hive/init.sh`를 설계 결정 10의 템플릿으로 생성하고 `chmod 0o755`, 이미 있고 `force`가 아니면 생성하지 않고 `{created:false, path}` 반환.

### 14. `/home/ed/src/hive/src/hookInstall.ts` (약 140줄)
- 순수 `HIVE_HOOK_EVENTS`(14개, 툴 이벤트 5개는 matcher `"*"`), `applyHiveHooks(settings, scriptPath)`, `removeHiveHooks(settings, scriptPath)`, `hiveHookStatus(settings, scriptPath): {event, installed}[]`.
- IO `installHooks({settingsPath, dryRun})`: 읽기(없으면 `{}`) → 백업 → apply → 쓰기. `uninstallHooks`, `statusHooks`. 기본 경로는 `${CLAUDE_CONFIG_DIR ?? ~/.claude}/settings.json`.

### 15. `/home/ed/src/hive/src/model.ts` (약 150줄)
- 순수 `buildRows({panes, agents, repoByCwd, sleepMap, now, mode}): Row[]`. `Row = {kind: 'group'|'window', key, sessionName, windowId, windowIndex, name, cwd, repoName?, branch?, state, source, prompt?, lastInputTs, lastInputIsFallback, sleep, active, depth}`. window별 상태 집계는 우선순위 waiting > working > unknown > done > idle. 설계 결정 8의 두 모드 정렬과 sleep 하단 배치.

### 16. `/home/ed/src/hive/src/tui/App.tsx` (약 250줄)
- `useHiveData(intervalMs=1000)` 훅: tick마다 `listPanes()` → `serverInfo()` → `ingestAll` → `pruneWindowFlags` → claude pane에 대해 3초마다 `capturePaneTail`로 screenWaiting 계산 → `buildRows` → state. 에러는 마지막 줄에 짧게 표시하고 다음 tick에 재시도.
- 렌더: 1행 제목 `hive  [recent|group]`, 2행 힌트, 이후 행마다 `아이콘 상태 window이름 (branch)` 형식. 선택 행 `inverse`, sleep 행 `dimColor`, waiting은 `color="yellow"`, working은 `color="green"`, 폭은 `useWindowSize()`에 맞춰 `wrap="truncate-end"`.
- 아이콘: working `●`, waiting `?`, done `✓`, idle `·`, unknown `◌`, sleep 접두 `z`.
- 키: `j/k/↑/↓` 이동, `Enter` → `selectWindow`, `s` → `setSleep` 토글, `g` 모드 전환(+ui.json 저장), `r` 강제 tick, `n` → 한 줄 입력 모드(branch) 후 `wtNew({repoRoot: 선택 행의 repoRoot})`, `q` → `cleanupFromTui()` 후 exit. 마우스는 설계 결정 3의 stdin 파서로 `row → 인덱스` 매핑 후 Enter와 동일 처리, 휠은 이동.
- `render(<App/>, {exitOnCtrlC: true})`. SIGTERM/SIGHUP에도 cleanup.

### 17. 테스트 (vitest)
- `/home/ed/src/hive/src/state.test.ts`: 이벤트 시퀀스 → 상태(UserPromptSubmit→working, PreToolUse AskUserQuestion→waiting+prompt, PermissionRequest→waiting, Stop→done, Stop이지만 서브에이전트 working 남음→working, SessionStart 리셋, SessionEnd→idle, 30분 경과→idle, `looksLikePermissionPrompt`).
- `/home/ed/src/hive/src/spool.test.ts`: 정상 줄, 깨진 JSON 건너뛰기, 개행 없는 마지막 줄 보류, offset 계산, `tmux` 문자열에서 소켓/PID 추출.
- `/home/ed/src/hive/src/model.test.ts`: recent 정렬, group 묶기, sleep 하단, window 상태 집계 우선순위, fallback 표시 플래그.
- `/home/ed/src/hive/src/hookInstall.test.ts`: 빈 settings에 설치 → 14개 이벤트, 기존 orca/curl hook 보존, 두 번 apply해도 동일 결과(멱등), remove 후 다른 hook만 남음, 툴 이벤트에만 matcher `*`.

### 18. `/home/ed/src/hive/README.md`
- 설치(`pnpm install && pnpm build`), `hive hook install`을 **사용자가 직접** 실행하라는 안내와 `--settings`, 백업 위치, `hook status`.
- `~/.tmux.conf`에 붙여넣을 스니펫(설계 결정 10의 `bind V`, `bind W`; 사이드바 포커스는 기존 `prefix+h` 사용). 실제 경로는 `hive paths`가 출력하는 값으로 채우라고 안내.
- env: `HIVE_HOME`, `HIVE_WORKTREE_BASE`, `HIVE_INIT_SCRIPT`, `HIVE_TMUX_SOCKET`, `CLAUDE_CONFIG_DIR`.
- 키 설명, 상태 아이콘, 알려진 제약(마우스 범위, 다른 세션).
- **쓰레드뷰 개념 정의 섹션**(사용자 요구사항에 있는 "쓰레드뷰 탭"의 문서화): 쓰레드뷰가 무엇인지(tmux window 하나 = 스레드 하나), 한 행이 무엇을 나타내는지, 5개 상태(working/waiting/done/idle/unknown)가 각각 어떤 hook 이벤트에서 오는지, sleep의 의미(표시 전용), 두 보기 모드의 차이, 사이드바가 window를 따라다니는 원리(tmux `session-window-changed` hook + `join-pane`)를 각 3~5줄로 적습니다.
- `hive wt init-script`로 init script를 만들고 고치는 방법, 실행 로그 위치(`~/.hive/logs/wt-<branch>.log`).

## 검증

### 자동 (구현 에이전트가 실행)

```
cd /home/ed/src/hive
pnpm install
pnpm typecheck
pnpm test
pnpm build
node dist/cli.js --help
node dist/cli.js paths
```

init script 생성 검증(스크래치 저장소에서, 실제 저장소를 건드리지 않음):

```
R=/tmp/claude-ed/hive-verify-repo; rm -rf $R; mkdir -p $R; git -C $R init -q
node dist/cli.js wt init-script --repo $R
node dist/cli.js wt init-script --repo $R
sh -n $R/.hive/init.sh && echo "SYNTAX OK"
test -x $R/.hive/init.sh && echo "EXEC OK"
```

통과 기준: 첫 실행에 `.hive/init.sh`가 생기고 실행 권한이 있으며, 두 번째 실행은 덮어쓰지 않고 이미 있다고 알립니다. `sh -n`으로 문법 오류가 없습니다.

hook 스크립트 단독 검증:

```
H=/tmp/claude-ed/hive-verify; rm -rf $H; mkdir -p $H
echo '{"session_id":"s1","hook_event_name":"UserPromptSubmit","prompt":"hi","cwd":"/home/ed/src/hive"}' | HIVE_HOME=$H TMUX_PANE='%7' TMUX='/tmp/tmux-1001/default,1986967,0' sh hooks/claude-hook.sh
echo '{"session_id":"s1","hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"which?"}]}}' | HIVE_HOME=$H TMUX_PANE='%7' TMUX='/tmp/tmux-1001/default,1986967,0' sh hooks/claude-hook.sh
HIVE_HOME=$H node dist/cli.js ingest
HIVE_HOME=$H node dist/cli.js ps --json
```

통과 기준: 첫 hook 실행 stdout이 `{}` 한 줄, `$H/spool/pane-_7.jsonl`에 2줄, `ps --json`에 pane `%7`이 `state: "waiting"`, `prompt: "which?"`로 나옵니다. `ingest`를 다시 실행해도 events 행 수가 늘지 않습니다.

hook install 격리 검증:

```
cp /home/ed/.claude/settings.json $H/settings.json
node dist/cli.js hook install --settings $H/settings.json
node dist/cli.js hook install --settings $H/settings.json
node dist/cli.js hook status --settings $H/settings.json
python3 -c "import json;d=json.load(open('$H/settings.json'));print({k:len(v) for k,v in d['hooks'].items()})"
node dist/cli.js hook uninstall --settings $H/settings.json
diff <(python3 -m json.tool /home/ed/.claude/settings.json) <(python3 -m json.tool $H/settings.json) && echo SAME
```

통과 기준: 두 번 install해도 이벤트별 항목 수가 한 번 install과 같고, `$H/settings.json.hive-backup-*`가 생기며, uninstall 후 원본과 동일(`SAME`). 원본 `/home/ed/.claude/settings.json`의 mtime이 변하지 않았음을 `stat`으로 확인합니다.

격리 tmux 서버 스모크(사용자 세션 미접촉):

```
tmux -L hivetest -f /dev/null new-session -d -s t -x 200 -y 50 -c /home/ed/src/hive
tmux -L hivetest set -g mouse on
tmux -L hivetest new-window -d -t t -n w2 -c /home/ed/src/empty
HIVE_HOME=$H HIVE_TMUX_SOCKET=/tmp/tmux-1001/hivetest TMUX_PANE=%0 TMUX=/tmp/tmux-1001/hivetest,0,0 node dist/cli.js sidebar show
sleep 2; tmux -L hivetest list-panes -a -F '#{window_id} #{pane_id} #{pane_left} #{pane_current_command}'
tmux -L hivetest capture-pane -p -t "$(tmux -L hivetest display-message -p -t t '#{@hive_sidebar_pane}')" | head -8
tmux -L hivetest select-window -t t:w2; sleep 1
tmux -L hivetest list-panes -a -F '#{window_id} #{pane_id} #{pane_left}'
tmux -L hivetest send-keys -t "$(tmux -L hivetest display-message -p -t t '#{@hive_sidebar_pane}')" j Enter; sleep 1
tmux -L hivetest display-message -p -t t '#{window_id}'
tmux -L hivetest kill-server
```

통과 기준: `sidebar show` 후 window 하나에 `left=0`인 node pane이 생기고 capture-pane에 `hive` 제목과 window 목록이 보입니다. `select-window` 후 사이드바 pane이 `w2` window의 `left=0`으로 이동합니다. 사이드바에 `j Enter`를 보내면 활성 window가 바뀝니다. `kill-server` 후 `tmux -L hivetest ls`가 "no server running"이어야 합니다.

### 사람이 눈으로 확인 (사용자 본인, 실제 세션에서)

1. `pnpm build` 후 `node dist/cli.js paths`로 경로를 확인하고, README의 스니펫을 `~/.tmux.conf`에 붙이고 `tmux source ~/.tmux.conf`.
2. `hive hook install`을 실행하고 `hive hook status`로 14개 이벤트가 installed인지 확인. 새 claude 세션을 하나 띄운다.
3. `prefix+V`를 누르면 현재 window 왼쪽에 34칸 쓰레드뷰가 뜬다. 다시 누르면 사라진다.
4. 쓰레드뷰가 뜬 상태에서 claude에 프롬프트를 넣으면 2초 안에 그 window 행이 `●`(초록)로 바뀌고, 답이 끝나면 `✓`, AskUserQuestion이나 권한 프롬프트가 뜨면 `?`(노랑)로 바뀐다.
5. `prefix+h`로 쓰레드뷰에 들어가 `j/k`로 다른 window를 고르고 Enter를 누르면 그 window로 이동하고 쓰레드뷰가 그 window 왼쪽에 따라와 있다. 포커스는 오른쪽 pane에 있다.
6. 마우스로 쓰레드뷰의 다른 행을 클릭하면 5와 같은 일이 일어난다.
7. `s`를 누르면 해당 행이 어두워지고 맨 아래로 내려간다. 다시 `s`를 누르면 복구된다.
8. `g`를 누르면 저장소/worktree별 묶음 보기로 바뀌고, 다시 누르면 최근 입력순으로 돌아온다.
9. `prefix+W`에 `feat/hive-demo`를 입력하면 `~/src/hive-worktrees/feat-hive-demo`가 생기고 새 window가 열리며, 왼쪽에 쓰레드뷰, 오른쪽에 `.hive/init.sh` 출력(없으면 `[hive] no init script`)과 셸이 보인다. 쓰레드뷰 group 모드에서 새 worktree가 `hive` 저장소 아래에 보인다.
10. `hive hook uninstall` 후 `~/.claude/settings.json`에 orca와 curl hook이 그대로 남아 있다.

## 리스크 / 확인 필요

- **마우스 클릭 좌표가 pane 기준인지**는 실제 클릭으로만 확인할 수 있습니다(격리 실험은 시퀀스를 직접 주입한 것). 좌표가 window 기준이면 사이드바가 항상 `left=0`이므로 x는 영향 없고 y도 같아 실질 문제는 없을 가능성이 큽니다. 클릭이 안 먹으면 키보드 경로로 요구사항을 만족시키고 README에 제약으로 적습니다.
- **hook 프로세스에 `TMUX_PANE`이 실제로 전달되는지**는 claude 프로세스 환경과 공식 문서(부모 환경 상속)로 간접 확인했습니다. 사용자가 `hive hook install` 후 `~/.hive/spool/`에 `pane-_N.jsonl`이 생기는지 보면 바로 확정됩니다. `nopane`으로만 쌓이면 `cwd`+`pane_current_path` 매칭 폴백을 추가해야 합니다(이번 범위 밖, 계획서에 기록만).
- `Notification` 이벤트의 입력 필드가 문서에 없습니다. `notification_type`이 payload에 있다고 가정하지 말고, matcher 없이 등록한 뒤 payload에서 `notification_type`이 있을 때만 waiting 판정에 씁니다.
- settings 변경이 **이미 떠 있는 claude 세션**에 반영되는지는 문서상 "자동 reload"지만 이 머신에서 확인하지 않았습니다. README에 "새 세션에서 확인"을 적습니다.
- 다른 tmux 세션의 window를 선택하면 `switch-client`가 필요하고, 사이드바 pane은 원래 세션에 남습니다. 이번 프로토타입은 목록에는 전 세션을 보여주되 이동은 같은 세션 안에서만 지원하고, 다른 세션 행은 dim 처리하고 Enter 시 `switch-client -t <session_name>`만 시도합니다(클라이언트 지정 없이 pane 안에서 실행할 때 동작하는지 확인 필요). 사용자 workpad가 worktree마다 세션을 만드는 구조라 실사용에서는 이 제약이 먼저 걸립니다.
- 스풀 파일 하나에 서브에이전트 hook이 동시에 붙을 수 있습니다. `flock`으로 직렬화하지만 `flock`이 없는 환경에서는 `PostToolUse.tool_output`처럼 큰 페이로드가 섞일 수 있습니다. 파서가 깨진 줄을 건너뛰도록 해 두었고, 이 머신에는 `/usr/bin/flock`이 있습니다.
- `git rev-parse`를 `execFileSync`로 부르므로 pane이 수십 개이고 캐시가 비어 있는 첫 tick에 수백 ms가 걸릴 수 있습니다. 프로토타입에서는 허용하고, 느리면 tick을 비동기 `execFile`로 바꿉니다.
- `node:sqlite`는 experimental이라 node 마이너 업그레이드에서 API가 바뀔 수 있습니다. `db.ts` 한 파일에만 의존을 가둬 두었습니다.
- 사이드바 폭 34칸을 `join-pane -l 34`에 하드코딩했습니다. 사용자가 pane 크기를 바꾸면 다음 이동에서 34로 돌아옵니다. 프로토타입에서는 허용합니다.
