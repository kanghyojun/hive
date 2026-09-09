# hive

tmux 위에서 여러 window의 AI agent(Claude Code, Codex) 상태를 한눈에 보는 쓰레드뷰 프로토타입입니다.

## 쓰레드뷰란

hive에서 tmux window 하나가 스레드 하나입니다. 사이드바의 한 항목은 window 하나를 나타내며, 그 window 안 pane에서 에이전트가 지금 뭘 하고 있는지를 보여줍니다. 항목은 두 줄입니다. 첫 줄이 제목(에이전트가 지금 하는 일), 둘째 줄이 그 창이 앉아 있는 `워크트리 : 브랜치`입니다. 두 줄이 한 덩어리로 보이게 왼쪽에 세로선을 세우고, 고른 항목과 지금 창은 이 선이 굵어집니다. 저장소 이름만 따로 머리글로 올라갑니다. 행 맨 앞의 `✱`는 Claude Code, `⬡`는 Codex이고, 목록에 종류가 하나뿐이면 이 열은 표시하지 않습니다(표기는 `src/state.ts`의 `AGENT_GLYPH`). window 안에 pane이 여러 개면 그 중 가장 급한 상태를 대표로 보여줍니다(waiting이 working보다 우선, working이 idle보다 우선하는 식).

사이드바 맨 아래에는 상태바가 붙습니다. 목록이 짧아도 pane 바닥에 고정되므로 눈이 한 자리만 보면 됩니다. 왼쪽부터 정렬 모드(`RECENT`/`GROUP`, 청록 블록), 잘려 나간 목록 수(`↑3↓5`), 맥 브라우저 브리지 상태(`ab●`/`ab✗`), 도움말 여는 키입니다. pane이 좁아지면 뒤에서부터 하나씩 접고 정렬 모드는 끝까지 남깁니다.

상태는 5가지입니다.

- `working`(●, 초록): `UserPromptSubmit`, `PostToolUse`, 일반 `PreToolUse` 이벤트가 오면.
- `waiting`(?, 노랑): `PermissionRequest`, `Notification`(권한/확인 대화상자), 또는 `AskUserQuestion` 같은 대화형 tool의 `PreToolUse`가 오면. 화면에 권한 승인 문구가 보이는데 hook 이벤트가 안 온 경우에도(3초마다 화면을 확인) waiting으로 표시합니다.
- `done`(✓): `Stop`이 오면. 단 서브에이전트가 아직 working으로 남아 있으면 working을 유지합니다.
- `idle`(·): `SessionEnd`가 오거나, 마지막 이벤트로부터 30분이 지나면.
- `unknown`(◌): hook 이벤트가 하나도 없는데 pane에 에이전트가 떠 있으면.

sleep(`s` 키)은 표시 전용입니다. 이벤트 흡수와 상태 계산은 계속하지만 화면에서는 어둡게(dimColor) 표시하고 목록 맨 아래로 내립니다. 자는 창으로 직접 들어가면(Enter, 숫자, 클릭) sleep이 풀립니다. 보고 있는 창이 목록 맨 아래 어두운 자리에 남아 있을 이유가 없습니다.

안 읽음 표시는 "상태가 바뀐 걸 내가 봤는가"를 남깁니다. 창이 `done`이나 `waiting`으로 바뀌면 그 행 오른쪽 끝에 막대(`▐`)가 붙습니다. 이 두 상태만 잡는 이유는 나머지가 부름이 아니라 진행 상황이기 때문입니다. working 시작이나 idle 전환에는 붙지 않습니다. 막대는 그 창에 들어가면 사라집니다. 사이드바에서 고르든(Enter, 숫자, 클릭) tmux로 직접 옮기든 마찬가지입니다. 지금 보고 있는 창은 눈앞에서 바뀐 것이라 애초에 붙지 않고, 어쩌다 붙었더라도 매 tick 지워집니다. `m`으로 직접 켜고 끌 수 있습니다. 지금은 볼 여유가 없어 표시를 남겨두거나, 들어가지 않고 표시만 지울 때 씁니다.

같은 상태가 이어지는 동안에는 다시 켜지지 않습니다. 마지막으로 본 상태를 `~/.hive/hive.db`의 `window_flags.seen_state`에 적어두고 그것과 달라질 때만 켭니다.

두 보기 모드(`g` 키로 전환)가 있습니다. `recent`는 최근 입력순 단일 목록이고, `group`은 저장소(repoRoot) → worktree 순으로 묶은 목록입니다. 마지막으로 고른 모드는 `~/.hive/ui.json`에 저장됩니다.

사이드바가 window를 따라다니는 원리는 tmux 자체 기능입니다. `hive sidebar show`가 사이드바 pane 하나를 만들고 그 id를 세션 옵션에 저장한 뒤, 세션에 `session-window-changed` hook을 걸어 둡니다. 이후 어떤 방법으로든 활성 window가 바뀌면 이 hook이 `join-pane`으로 사이드바 pane을 새 window의 왼쪽으로 옮깁니다. TUI 프로세스는 하나만 떠 있고 상태를 잃지 않습니다.

## 설치

```
pnpm install
pnpm build
node dist/cli.js paths   # 아래 tmux 스니펫에 채울 절대경로 확인
```

`hive hook install`은 **사용자가 직접** 실행합니다(구현 스크립트가 실제 설정 파일을 건드리지 않습니다).

```
hive hook install                      # claude와 codex 양쪽에 설치
hive hook install --agent codex        # 한쪽만
hive hook install --settings <path>          # Claude 쪽 다른 경로에 설치(테스트용)
hive hook install --codex-hooks <path>       # Codex 쪽 다른 경로에 설치(테스트용)
hive hook status                       # 에이전트별 이벤트 설치 여부 확인
hive hook uninstall                    # 우리 hook만 제거, 다른 hook은 그대로 둠
```

설치 위치는 Claude Code가 `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json`, Codex가 `${CODEX_HOME:-$HOME/.codex}/hooks.json`입니다. install은 쓰기 전에 같은 디렉토리에 `<파일>.hive-backup-<ISO시각>` 백업을 남기고, 이미 등록된 hook(같은 command)은 건너뜁니다(멱등). 설정 변경은 문서상 Claude Code가 자동으로 reload하지만, 확실히 하려면 새 세션을 하나 띄워 확인하세요.

### Codex는 신뢰 승인이 한 번 더 필요합니다

Codex는 `hooks.json`에 적힌 hook을 그냥 실행하지 않습니다. hook이 새로 생기거나 바뀌면 codex를 띄울 때 "Hooks need review"를 묻고, 여기서 승인해야(`Trust all and continue` 또는 `Review hooks`) 실제로 돕니다. 승인 결과는 `config.toml`의 `[hooks.state."<hooks.json 경로>:<이벤트>:<그룹>:<항목>"]`에 `enabled = true`로 남습니다.

```
hive hook status --agent codex   # installed 옆 trusted/untrusted 열이 승인 여부
```

`untrusted`로 남아 있으면 hook이 등록만 되고 이벤트는 오지 않는 상태입니다. codex를 한 번 새로 띄워 승인하세요. hook 스크립트 경로가 바뀌면 승인도 다시 받아야 합니다.

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
- `Enter`: 선택한 window로 이동 (사이드바는 그 window를 따라옵니다). 자는 창이면 sleep이 풀리고, 안 읽음 표시도 지워집니다
- `s`: 선택한 window sleep 토글
- `m`: 선택한 window 안 읽음 토글
- `g`: `recent`/`group` 보기 전환
- `n`: branch 이름 입력 후 그 저장소에 `wt new` 실행 (새 세션이 열리고 그리로 이동합니다)
- `o`: 안 열린 worktree 목록에서 골라 열기. 아는 저장소마다 "+ 새 worktree" 항목이 있어 그 자리에서 `n`과 같은 입력줄로 넘어갑니다. 맨 아래 "+ 다른 저장소 찾기…"는 hive가 아직 모르는 저장소로 가는 입구입니다. `~/`부터 시작하는 입력줄에 경로를 치면 한 단계씩 하위 디렉토리를 fuzzy로 걸러 보여주고(↑/↓·Tab·Ctrl-n/p로 커서, Esc 취소), `● git`으로 표시된 저장소에서 Enter를 누르면 브랜치 입력줄로 넘어가 그 자리에서 worktree와 세션을 새로 만듭니다. 한 번 쓴 저장소는 `~/.hive/repos.json`에 적혀 다음부터는 목록에 바로 뜹니다
- `p`: 선택한 행의 저장소에서 열린 PR을 골라 worktree로 열기. `gh pr list`를 비동기로 부르고 그동안 "gh에 물어보는 중…"을 보여줍니다(이 화면에서 유일한 네트워크 호출이라 동기로 부르면 사이드바가 통째로 멈춥니다). 목록에서 Enter를 누르면 `wt pr`과 같은 일이 벌어집니다. `o` 목록에도 저장소마다 "+ PR에서 열기" 항목이 있어, 창이 하나도 안 떠 있는 저장소는 그쪽으로 들어갑니다
- `D`: 선택한 행의 worktree 삭제. 확인 후 `git worktree remove` + 그 worktree를 쓰던 tmux 창 종료까지 합니다. 커밋 안 된 변경이 있으면 `yes`를 쳐야 지웁니다. 메인 저장소와 마지막 세션은 거부합니다. 브랜치는 남깁니다
- `u`: 사용량 보기 토글
- `r`: 강제 새로고침
- `q`: 종료 (hook/옵션 정리 후 pane이 닫힙니다)

마우스는 사이드바 pane 안에서 왼쪽 클릭으로 항목 선택+이동, 휠로 스크롤만 지원합니다. 항목의 두 줄 중 어느 쪽을 눌러도 같은 창으로 갑니다. pane 바깥 클릭, 드래그, 더블클릭은 지원하지 않습니다.

## worktree

```
hive wt init-script [--repo <path>] [--force]   # <repo>/.hive/init.sh 템플릿 생성
hive wt new <branch> [--repo <path>] [--base <ref>] [--no-init]
hive wt pr <번호> [--repo <path>] [--no-init]
hive wt open <branch|path|디렉토리이름> [--repo <path>] [--init]
hive wt rm <branch|path|디렉토리이름> [--repo <path>] [--force]
hive wt list [--repo <path>]
```

`wt new`가 여는 세션은 지금 보고 있는 window와 같은 크기로 만듭니다. 크기를 안 주면 tmux가 `default-size`(80x24)나 마지막 클라이언트 크기로 세션을 만들고, 나중에 클라이언트가 붙을 때 pane을 비율로 늘려 사이드바가 화면 절반을 차지합니다.

`wt new`는 `HIVE_WORKTREE_BASE` 아래에 git worktree를 만들고, init script(`HIVE_INIT_SCRIPT` env > `<repo>/.hive/init.sh` 순으로 찾음)를 실행한 뒤, **tmux 세션을 하나 새로 엽니다**(왼쪽 쓰레드뷰, 오른쪽 init 로그 → 셸). worktree 하나가 세션 하나입니다. 세션 이름은 브랜치명이고(`/`, `.`, `:`, 공백은 `-`로 바꿉니다), 같은 이름이 이미 있으면 `-2`, `-3`을 붙입니다. 세션을 만든 뒤에는 붙어 있는 클라이언트를 그 세션으로 옮깁니다(`switched: false`면 옮길 클라이언트가 없었다는 뜻이고, 세션은 그대로 만들어져 있습니다).

세션을 새로 여는 건 `wt new`뿐입니다. 같은 세션 안에 손으로 window를 열어 다른 worktree에서 작업해도 사이드바는 그대로 잡습니다. 목록은 세션이 아니라 window 단위입니다.

init script 실행 로그는 `~/.hive/logs/wt-<branch>.log`에 남습니다. init script가 실패해도 worktree와 세션은 그대로 유지되고 exit code만 알립니다.

`wt pr`은 GitHub PR 하나를 worktree로 엽니다. `gh`로 PR 정보를 읽고 `git fetch origin +refs/pull/<번호>/head:<로컬브랜치>`로 받아온 뒤 `wt new`와 같은 모양으로 세션을 엽니다. 로컬 브랜치와 디렉토리 이름은 `pr-<번호>-<헤드브랜치>`입니다(헤드브랜치는 git 브랜치명에 쓸 수 있는 글자만 남기고 32자에서 자릅니다). 번호는 `12`도 `#12`도 됩니다.

`refs/pull`을 쓰는 덕분에 fork에서 온 PR도 remote를 더하지 않고 같은 명령으로 받습니다. 대신 upstream이 안 붙어 **push는 안 됩니다**. 리뷰용입니다.

이미 그 PR의 worktree가 있으면 받아오지 않고 `wt open`처럼 그 자리를 엽니다(`reused: true`). 열려 있는 브랜치로는 fetch가 거부되기도 하고, PR은 리뷰하다 나갔다 다시 들어오는 일이 잦습니다. 그래서 PR에 새 커밋이 올라와도 자동으로 따라가지 않습니다. 최신으로 맞추려면 그 worktree에서 직접 받거나 `D`로 지우고 다시 여세요.

`gh`가 없거나, 인증이 안 됐거나, GitHub 저장소가 아니면 그 이유를 한 줄로 알려줍니다. hive가 대신 `gh auth login`을 해주지는 않습니다.

`wt open`은 저장소에는 있지만 tmux에 안 떠 있는 worktree를 `wt new`와 같은 모양(세션 하나, 왼쪽 사이드바, 오른쪽 셸)으로 엽니다. 이미 열려 있으면 그 세션으로 옮기고 `alreadyOpen`을 돌려줍니다. 이미 있던 worktree는 의존성이 깔려 있다고 보고 init script를 기본으로 돌리지 않습니다(`--init`으로 돌립니다).

`wt rm`은 (1) 커밋 안 된 변경이 있으면 `--force` 없이는 거부하고, (2) `git worktree remove`를 먼저 부른 뒤, (3) 그 worktree 안에 pane이 있는 tmux 창을 닫습니다. 창 소속은 `pane_current_path` 접두사로 판단하므로 worktree 밖으로 `cd`한 창은 안 닫히고, 셸만 열어 둔 창은 같이 닫힙니다. 남는 세션이 없으면(마지막 세션이면 tmux 서버까지 내려갑니다) 창은 그대로 두고 `skippedReason`을 돌려줍니다. 브랜치는 지우지 않습니다.

`wt list`의 각 항목에는 그 worktree를 쓰고 있는 창 목록이 `windows`로 붙습니다. tmux 밖에서 부르면 항상 빈 배열입니다.

`wt new`/`wt open`/`wt rm`을 한 저장소는 `~/.hive/repos.json`에 적어 둡니다. 창이 하나도 안 떠 있는 저장소를 `o` 목록에 보여주려면 이 목록이 필요합니다.

## cron

```
hive cron list [--json]
hive cron add <id> --schedule "<크론식>" --repo <path> --prompt <text>
               [--worktree reuse|new|path] [--path <path>] [--branch <tpl>] [--base <ref>] [--init]
               [--agent claude|codex] [--arg <값>]... [--grace <ms>] [--overlap skip|allow]
               [--no-keep-window] [--disabled]
hive cron rm <id>
hive cron enable <id> | hive cron disable <id>
hive cron run <id> [--force] [--fire-at <ms>] [--claim <rowid>]
hive cron runs [--id <job>] [--limit <n>] [--json]
hive cron next [--at <iso>]
hive cron tick [--spawn]
```

정해진 시각에 worktree에서 에이전트를 띄웁니다. 잡은 `~/.hive/cron.json`에, 실행 이력은 `hive.db`의 `cron_runs`에 남습니다.

```
hive cron add llmwiki-daily --schedule "0 11 * * *" \
  --repo ~/src/llmwiki --prompt "할 일이 있으면 todo로 만들어라"
```

**띄우는 방식은 사람이 하는 것과 같습니다.** tmux 창을 열고 그 안에서 `claude '<프롬프트>'`를 실행합니다(`-p`가 아니라 대화형입니다). 그래서 hook이 붙어 있으면 진행 상태가 사이드바에 그대로 나오고, 권한 프롬프트가 뜨면 사람이 가서 누를 수 있습니다. 창 이름은 `cron:<id>`입니다. 권한 옵션처럼 CLI에 넘길 인자는 `--arg`로 붙입니다(`--arg --permission-mode --arg acceptEdits`). hive는 기본값을 넣지 않습니다.

그 worktree에 이미 창이 있으면 같은 세션에 창을 하나 더 붙이고, 없으면 세션을 새로 엽니다. 어느 쪽이든 **보고 있는 화면을 뺏지 않습니다**(`wt new`와 달리 `switch-client`를 부르지 않습니다).

`--worktree`로 어디서 돌릴지 고릅니다. `reuse`(기본)는 `--repo` 경로 그대로, `path`는 `--path`로 준 경로, `new`는 `--branch` 템플릿으로 worktree를 새로 팝니다. 템플릿에는 `{date}`(로컬 YYYY-MM-DD), `{job}`, `{ts}`를 쓸 수 있고, 그 자리가 이미 있으면 그대로 씁니다. 커밋이나 푸시는 hive가 하지 않습니다. 필요하면 프롬프트에 적으세요.

스케줄은 cron 5필드(분 시 일 월 요일)입니다. `*`, 숫자, 리스트(`1,15`), 범위(`1-5`), 스텝(`*/15`), 요일·월 이름(`mon`, `jan`)을 씁니다. 일과 요일을 둘 다 지정하면 표준 cron대로 OR로 칩니다. 시각은 로컬 타임존 기준입니다.

**데몬은 없습니다.** 사이드바 TUI가 어디든 하나라도 떠 있으면 30초마다 판정합니다. 사이드바가 여러 개 떠 있어도 잡은 한 번만 돕니다. 전부 같은 예정 시각 정수를 계산하고, `cron_runs`의 `UNIQUE(job_id, fire_at)`이 하나만 통과시키기 때문입니다.

hive가 꺼져 있어 실행 시각을 놓쳤으면 `--grace`(기본 6시간) 안에서만 따라잡습니다. 몇 번을 놓쳤든 한 번만 돕니다. 주 1회 잡이라면 유예를 이틀쯤으로 늘리는 게 맞습니다. 잡을 만들기 전의 예정 시각은 따라잡지 않습니다.

실행 중인 잡이 다음 시각을 맞으면 기본으로 건너뜁니다(`--overlap allow`로 바꿉니다). "실행 중"은 창이 살아 있는 동안입니다. 창이 사라지면 끝난 것으로 봅니다. hive는 창을 띄우는 데까지만 알고 에이전트가 성공했는지는 모릅니다.

`hive cron run <id> --force`는 스케줄과 무관하게 지금 한 번 돌립니다. 자동 실행과 같은 코드를 타므로 잡을 등록한 뒤 이걸로 한 번 확인해 보는 게 좋습니다.

`hive cron tick`은 한 번 평가하고 끝냅니다. TUI 없이 돌리고 싶으면 이 한 줄을 시스템 crontab이나 systemd timer에 걸어도 됩니다.

잡 하나에 오타가 나도 나머지는 그대로 돕니다. 걸러낸 이유는 `hive cron list`에 `!`로 붙고, TUI에서 난 실패는 `~/.hive/logs/cron.log`에 남습니다.

## ab-bridge

`ab-local`이 PATH에 있을 때만 하단 상태바에 맥 브라우저 브리지(CDP) 상태를 `ab●`(연결됨) / `ab✗`(안 됨)로 보여줍니다. 30초마다 `tailscale ip -4 <macHost>`로 IP를 얻어 `http://<ip>:<port>/json/version`을 확인합니다. 설정은 `${AB_BRIDGE_CONFIG:-~/.config/ab-bridge/profiles.json}`을 읽고, 없으면 ab-bridge와 같은 기본값(`macbookpro:9222`)으로 돕니다.

`ab✗`면 맥에서 `ab-up`을 실행해야 합니다. hive가 대신 실행하지는 않습니다.

```
hive ab status
```

## 사용량

`u` 키로 켜는 패널입니다. Claude Code와 Codex의 창 사용률(%)과 리셋까지 남은 시간만 보여줍니다. 달러 환산, 토큰 합계, 세션별 사용량은 없습니다. 뷰가 꺼져 있으면 파일을 아예 읽지 않고, 켜져 있으면 30초마다 읽습니다.

**Claude 쪽은 `hive statusline`을 statusLine으로 등록해야 보입니다.** Claude Code는 창 사용률을 statusLine 커맨드의 stdin JSON으로만 넘깁니다. hook이나 트랜스크립트에는 없습니다. 그래서 statusLine 자리를 빌리는 것 말고는 이 값을 얻을 길이 없습니다.

`~/.claude/settings.json`을 직접 고치세요(hive는 이 파일을 고치지 않습니다). 이미 쓰던 statusLine이 있으면 `--exec`로 감싸면 됩니다.

```json
"statusLine": {
  "type": "command",
  "command": "hive statusline --exec '원래 쓰던 명령'"
}
```

`hive statusline`은 stdin을 읽어 사용량만 `~/.hive/claude-usage.json`에 저장하고, 읽은 stdin 원문을 그대로 감싼 명령에 넘긴 뒤 그 출력과 종료 코드를 그대로 전달합니다. HUD 화면은 그대로 남습니다. statusLine을 안 쓰고 있었다면 `--exec` 없이 `hive statusline`만 등록하면 됩니다(아무것도 출력하지 않습니다).

`hive`가 PATH에 없으면 절대경로가 필요합니다. `hive paths`의 `execPath`와 `cli`를 이어 붙여 `/path/to/node /path/to/dist/cli.js statusline --exec '...'`처럼 씁니다.

statusLine은 Claude Code 세션이 떠 있을 때만 돌기 때문에 세션이 다 닫히면 값이 멈춥니다(그래서 갱신 시각을 같이 보여줍니다). 값이 그대로면 30초 안에는 파일을 다시 쓰지 않습니다.

claude-hud를 쓰던 사람은 hud의 `display.externalUsageWritePath` 설정도 그대로 동작합니다. hive는 `HIVE_CLAUDE_USAGE_PATH` → `~/.hive/claude-usage.json`(있으면) → hud 설정의 `externalUsageWritePath` → `~/.hive/claude-usage.json` 순으로 스냅샷을 찾습니다.

Codex는 설정이 필요 없습니다. `~/.codex/sessions`의 최신 rollout 파일 꼬리에서 마지막 `token_count` 줄의 `rate_limits`를 읽습니다. 따라서 값은 마지막 codex 응답 시점 기준이고, 플랜에 따라 5시간 창이 없을 수 있습니다(`prolite`는 7일 창만 냅니다).

```
hive usage    # 두 출처에서 읽은 원본과 스냅샷 경로 확인
```

## 환경변수

- `HIVE_HOME` (기본 `~/.hive`): `hive.db`, `spool/`, `logs/`, `ui.json`을 두는 데이터 디렉토리.
- `HIVE_WORKTREE_BASE` (기본 `{repoParent}/hive-worktrees/{repo}`): `wt new`가 worktree를 만들 위치. `{repoParent}`, `{repo}` 플레이스홀더를 치환합니다. hive가 판 worktree는 `hive-worktrees` 한 곳에 모이고 그 안에서 저장소 이름으로 나뉩니다. 디렉토리 이름 자체가 "hive가 만든 것"이라는 표시입니다. 브랜치명의 `/`는 `-`로 바뀝니다(`feature/a` → `feature-a`).
- `HIVE_INIT_SCRIPT`: `<repo>/.hive/init.sh`보다 우선하는 init script 절대경로.
- `HIVE_TMUX_SOCKET`: tmux 소켓 경로. 없으면 `$TMUX`의 첫 필드, 그것도 없으면 기본 소켓.
- `CLAUDE_CONFIG_DIR`: `hive hook`이 기본으로 읽고 쓰는 `settings.json`의 디렉토리. 사용량은 자기 스냅샷이 없을 때만 이 디렉토리 아래 `plugins/claude-hud/config.json`도 읽습니다(읽기만 합니다).
- `CODEX_HOME` (기본 `~/.codex`): `hive hook`의 `hooks.json`과 사용량이 읽는 `sessions/` 위치.
- `AB_BRIDGE_CONFIG` (기본 `~/.config/ab-bridge/profiles.json`): ab-bridge 설정 파일 경로.
- `HIVE_HOME/cron.json`: cron 잡 정의. 환경변수는 아니지만 `hive cron add`가 쓰고 사람이 직접 고쳐도 됩니다.
- `HIVE_CLAUDE_USAGE_PATH`: Claude 사용량 스냅샷 경로를 직접 지정. `~/.hive/claude-usage.json`과 hud 설정값보다 우선합니다.

## 알려진 제약

- 마우스 클릭 좌표가 pane 기준인지는 사람이 실제로 클릭해서 확인해야 합니다(자동 검증 범위 밖).
- 다른 tmux 세션의 window로는 목록에 보이되 dim 처리되고, 이동 시 `switch-client`를 시도합니다만 이 경로는 실사용에서 충분히 검증되지 않았습니다.
- codex를 npm 래퍼로 설치하면 `#{pane_current_command}`가 `node`로 나옵니다(실측). 그래서 3초마다 `ps`로 pane 하위 프로세스를 훑어 `claude`/`codex`를 찾습니다. 한 pane에서 claude가 codex를 자식으로 돌리면 얕은 쪽인 claude로 표시됩니다.
- 사이드바 폭은 41칸으로 고정입니다(`src/sidebar.ts`의 `SIDEBAR_WIDTH`). tmux는 window 크기가 바뀌면 pane을 비율로 다시 나누기 때문에, 크기가 다른 클라이언트가 오가면 이 폭이 27칸이나 78칸으로 벌어집니다. TUI가 자기 폭을 보고 어긋나면 1초 안에 41로 되돌립니다. 그래서 pane 크기를 수동으로 바꿔도 유지되지 않습니다. 창이 좁아 41칸을 못 주면 되돌리기를 포기하고 다음 크기 변화까지 그대로 둡니다.
- cron이 아는 것은 "창을 띄웠다"까지입니다. 에이전트가 일을 제대로 마쳤는지는 모릅니다. 창이 사라지면 끝난 것으로 칠 뿐입니다.
- cron이 `--worktree new`로 판 worktree는 아무도 안 지웁니다. 주 1회면 1년에 52개가 쌓입니다. `hive wt rm`으로 직접 지우세요.
- transcript tail, OSC 타이틀 파싱, 알림, 원격 접근, 멀티 머신 동기화, 테마, CI, 배포는 이번 프로토타입 범위 밖입니다.
