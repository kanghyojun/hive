# hive

tmux 위에서 여러 window의 AI agent(Claude Code) 상태를 한눈에 보는 쓰레드뷰 프로토타입입니다.

## 쓰레드뷰란

hive에서 tmux window 하나가 스레드 하나입니다. 사이드바의 한 행은 window 하나를 나타내며, 그 window 안 pane에서 Claude Code가 지금 뭘 하고 있는지를 보여줍니다. window 안에 pane이 여러 개면 그 중 가장 급한 상태를 대표로 보여줍니다(waiting이 working보다 우선, working이 idle보다 우선하는 식).

상태는 5가지입니다.

- `working`(●, 초록): `UserPromptSubmit`, `PostToolUse`, 일반 `PreToolUse` 이벤트가 오면.
- `waiting`(?, 노랑): `PermissionRequest`, `Notification`(권한/확인 대화상자), 또는 `AskUserQuestion` 같은 대화형 tool의 `PreToolUse`가 오면. 화면에 권한 승인 문구가 보이는데 hook 이벤트가 안 온 경우에도(3초마다 화면을 확인) waiting으로 표시합니다.
- `done`(✓): `Stop`이 오면. 단 서브에이전트가 아직 working으로 남아 있으면 working을 유지합니다.
- `idle`(·): `SessionEnd`가 오거나, 마지막 이벤트로부터 30분이 지나면.
- `unknown`(◌): hook 이벤트가 하나도 없는데 pane에 `claude`가 떠 있으면.

sleep(`s` 키)은 표시 전용입니다. 이벤트 흡수와 상태 계산은 계속하지만 화면에서는 어둡게(dimColor) 표시하고 목록 맨 아래로 내립니다.

두 보기 모드(`g` 키로 전환)가 있습니다. `recent`는 최근 입력순 단일 목록이고, `group`은 저장소(repoRoot) → worktree 순으로 묶은 목록입니다. 마지막으로 고른 모드는 `~/.hive/ui.json`에 저장됩니다.

사이드바가 window를 따라다니는 원리는 tmux 자체 기능입니다. `hive sidebar show`가 사이드바 pane 하나를 만들고 그 id를 세션 옵션에 저장한 뒤, 세션에 `session-window-changed` hook을 걸어 둡니다. 이후 어떤 방법으로든 활성 window가 바뀌면 이 hook이 `join-pane`으로 사이드바 pane을 새 window의 왼쪽으로 옮깁니다. TUI 프로세스는 하나만 떠 있고 상태를 잃지 않습니다.

## 설치

```
pnpm install
pnpm build
node dist/cli.js paths   # 아래 tmux 스니펫에 채울 절대경로 확인
```

`hive hook install`은 **사용자가 직접** 실행합니다(구현 스크립트가 실제 `~/.claude/settings.json`을 건드리지 않습니다).

```
hive hook install                 # 기본 경로: ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json
hive hook install --settings <path>   # 다른 경로에 설치(테스트용)
hive hook status                  # 14개 이벤트 설치 여부 확인
hive hook uninstall                # 우리 hook만 제거, 다른 hook은 그대로 둠
```

install은 쓰기 전에 같은 디렉토리에 `settings.json.hive-backup-<ISO시각>` 백업을 남기고, 이미 등록된 hook(같은 command)은 건너뜁니다(멱등). 설정 변경은 문서상 Claude Code가 자동으로 reload하지만, 확실히 하려면 새 세션을 하나 띄워 확인하세요.

## tmux 설정

`~/.tmux.conf`에 아래를 붙이고 경로는 `hive paths` 출력값으로 채웁니다.

```
bind V run-shell -b "<node> <cli.js> --pane '#{pane_id}' sidebar toggle"
bind W command-prompt -p "branch:" "run-shell -b \"<node> <cli.js> --pane '#{pane_id}' wt new %% --repo '#{pane_current_path}'\""
```

`--pane '#{pane_id}'`를 빼면 안 됩니다. tmux가 `run-shell`로 실행하는 명령에는 `TMUX_PANE`이
들어오지 않아서(`-t`를 줘도 마찬가지) hive가 어느 pane에서 불렸는지 알 수 없습니다. `run-shell`은
`#{...}` 포맷을 확장하므로 이렇게 pane id를 직접 넘깁니다. 옵션이 없으면 활성 pane을 조회하는
폴백이 돌지만, 클라이언트가 여러 개 붙어 있으면 엉뚱한 pane을 집을 수 있습니다.

사이드바로 포커스를 옮기는 별도 바인딩은 없습니다. 기존 `prefix+h`(`select-pane -L`)를 그대로 씁니다.

바인딩이 조용히 실패하면 tmux는 `'...' returned 1`만 보여줍니다. 원인은
`~/.hive/logs/cli-error.log`에 스택으로 남습니다.

## 키

사이드바 TUI 안에서:

- `j`/`k`/↑/↓: 행 이동
- `Enter`: 선택한 window로 이동 (사이드바는 그 window를 따라옵니다)
- `s`: 선택한 window sleep 토글
- `g`: `recent`/`group` 보기 전환
- `n`: branch 이름 입력 후 그 저장소에 `wt new` 실행 (새 세션이 열리고 그리로 이동합니다)
- `r`: 강제 새로고침
- `q`: 종료 (hook/옵션 정리 후 pane이 닫힙니다)

마우스는 사이드바 pane 안에서 왼쪽 클릭으로 행 선택+이동, 휠로 스크롤만 지원합니다. pane 바깥 클릭, 드래그, 더블클릭은 지원하지 않습니다.

## worktree

```
hive wt init-script [--repo <path>] [--force]   # <repo>/.hive/init.sh 템플릿 생성
hive wt new <branch> [--repo <path>] [--base <ref>] [--no-init]
```

`wt new`는 `HIVE_WORKTREE_BASE` 아래에 git worktree를 만들고, init script(`HIVE_INIT_SCRIPT` env > `<repo>/.hive/init.sh` 순으로 찾음)를 실행한 뒤, **tmux 세션을 하나 새로 엽니다**(왼쪽 쓰레드뷰, 오른쪽 init 로그 → 셸). worktree 하나가 세션 하나입니다. 세션 이름은 브랜치명이고(`/`, `.`, `:`, 공백은 `-`로 바꿉니다), 같은 이름이 이미 있으면 `-2`, `-3`을 붙입니다. 세션을 만든 뒤에는 붙어 있는 클라이언트를 그 세션으로 옮깁니다(`switched: false`면 옮길 클라이언트가 없었다는 뜻이고, 세션은 그대로 만들어져 있습니다).

세션을 새로 여는 건 `wt new`뿐입니다. 같은 세션 안에 손으로 window를 열어 다른 worktree에서 작업해도 사이드바는 그대로 잡습니다. 목록은 세션이 아니라 window 단위입니다.

init script 실행 로그는 `~/.hive/logs/wt-<branch>.log`에 남습니다. init script가 실패해도 worktree와 세션은 그대로 유지되고 exit code만 알립니다.

## 환경변수

- `HIVE_HOME` (기본 `~/.hive`): `hive.db`, `spool/`, `logs/`, `ui.json`을 두는 데이터 디렉토리.
- `HIVE_WORKTREE_BASE` (기본 `{repoParent}/{repo}-worktrees`): `wt new`가 worktree를 만들 위치. `{repoParent}`, `{repo}` 플레이스홀더를 치환합니다.
- `HIVE_INIT_SCRIPT`: `<repo>/.hive/init.sh`보다 우선하는 init script 절대경로.
- `HIVE_TMUX_SOCKET`: tmux 소켓 경로. 없으면 `$TMUX`의 첫 필드, 그것도 없으면 기본 소켓.
- `CLAUDE_CONFIG_DIR`: `hive hook`이 기본으로 읽고 쓰는 `settings.json`의 디렉토리.

## 알려진 제약

- 마우스 클릭 좌표가 pane 기준인지는 사람이 실제로 클릭해서 확인해야 합니다(자동 검증 범위 밖).
- 다른 tmux 세션의 window로는 목록에 보이되 dim 처리되고, 이동 시 `switch-client`를 시도합니다만 이 경로는 실사용에서 충분히 검증되지 않았습니다.
- 사이드바 폭은 34칸으로 고정입니다(`join-pane -l 34`). pane 크기를 수동으로 바꿔도 다음 window 이동에서 34로 돌아옵니다.
- codex 감지, transcript tail, OSC 타이틀 파싱, 알림, 원격 접근, 멀티 머신 동기화, 테마, CI, 배포는 이번 프로토타입 범위 밖입니다.
