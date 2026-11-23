# 에이전트 API v2 (`window.hwpAgent`)

브라우저 안의 어떤 에이전트(Claude in Chrome 의 javascript_tool, Aside, ChatGPT 브라우저 등)든 서버 없이 같은 페이지의 문서를 읽고 고칠 수 있게 한 표면이다.
구현은 `cs/studio/agent-tools-{core,global,plugin,pure}.ts`, 원본(upstream) 파일은 고치지 않았다(`PATCHES.md` 변경 없음).
기존 40개 도구의 이름·인자·결과는 그대로이고(결과에 `verified` 필드만 더해진 도구가 있다), 새 도구 5개가 뒤에 붙어 모두 45개다.

## 발견

| 방법 | 내용 |
|---|---|
| `window.hwpAgent` | `window.rhwpStudio.csAgentTools` 와 같은 API 의 짧은 별칭. 처음 부를 때 플러그인을 올린다. |
| `await hwpAgent.help()` | 한국어 + 핵심 영어 사용 설명서(약 5,800자 이하). 시작법, 모든 도구 이름과 인자, 오류 코드, 규칙이 들어 있다. 도구 목록에서 만들어서 새 도구가 생기면 자동으로 따라온다. |
| `<meta name="ai-agent-api" content="window.hwpAgent — call await hwpAgent.help()">` | 시작할 때 `<head>` 에 넣는다. 플러그인은 올리지 않는다(게이트가 확인). |
| WebMCP | `document.modelContext?.registerTool` 이 있을 때만, 한가한 때 플러그인을 올려 모든 도구를 `{name, description, inputSchema, execute}` 로 등록한다. 없으면 아무 일도 하지 않고, 등록이 던져도 편집기는 정상이다. `execute` 는 `{content:[{type:'text', text: JSON.stringify(callTool 결과)}]}` 를 돌려준다. |

## 호출

```js
const r = await hwpAgent.callTool(name, args, { dryRun?: true });
// 성공 {ok:true, result} / 실패 {ok:false, error:{code, message, details?}, result?}
await hwpAgent.undo(); await hwpAgent.redo();
await hwpAgent.exportDocument('hwpx'); await hwpAgent.loadDocument(bytes, 'a.hwpx');
```

권장 순서: `get_document_info` → 읽기(`get_outline`, `read_paragraphs`, `list_tables`, `read_table`, `list_fields`) → 계획 → `run_plan`.
읽기 먼저, 편집은 그다음. `find` 는 읽은 글을 글자 그대로 복사해야 하고, 한 곳만 맞아야 한다(여럿이면 `occurrence`).

## 새 도구

| 도구 | 그룹 | 인자 | 결과 |
|---|---|---|---|
| `list_tables` | read | 없음 | `[{table, section, rows, cols, hasMerge, firstCellText, precedingText}]` (`table` 은 본문 1단계 표의 문서 순서 번호, 0부터. 칸 안 중첩 표는 세지 않는다) |
| `read_table` | read | `table`, `maxRows?` | `{table, rows, cols, cells:string[][], merges:[{row,col,rowSpan,colSpan}]}` 칸 글은 병합 칸의 anchor(왼쪽 위)에만 있고 덮인 칸은 `""`. 한 칸에 문단이 여럿이면 `\n` 으로 잇는다. |
| `set_cells` | write | `table`, `cells:[{row,col,text}]` | `{changed:[{row,col,oldText,newText}], unchanged, verified}` row·col 은 0부터. **모든 칸을 먼저 검사**하고 하나라도 잘못이면 아무것도 쓰지 않는다. |
| `fill_fields` | write | `values:{이름: 값}` | `{filled:[{name,occurrence,oldValue,value,changed}], notFound:[], ambiguous:[{name,matched,total}], invalid:[], verified}` 없는 이름은 `notFound` 에 담고 던지지 않는다. 같은 이름이 여럿이고 순번이 없으면 `ambiguous` 로 두고 채우지 않는다. `"이름[2]"` 는 둘째 누름틀(1부터). |
| `run_plan` | write | `steps:[{tool,args}]`, `dryRun?` | 아래 |

### 오류 코드
기존: `TARGET_NOT_FOUND`, `AMBIGUOUS_TARGET`, `INVALID_INPUT`, `UNKNOWN_TOOL`, `FILE_REQUIRED`, `DOCUMENT_RELEASED`, `APPLY_FAILED`, `REFUSED`.
새로 생긴 것: `COVERED_BY_MERGE`(메시지에 anchor 의 row/col), `OUT_OF_RANGE`, `TABLE_NOT_FOUND`, `CELL_NOT_FOUND`, `DUPLICATE_CELL`, `MULTI_PARAGRAPH_CELL`(여러 문단 칸은 `set_cells` 가 쓰지 않는다 → `replace_text`), `PLAN_INVALID`, `PLAN_FAILED`, `STEP_NOT_ALLOWED`, `DRYRUN_UNSUPPORTED`.
`set_cells` 의 오류는 `error.details` 에 모든 문제 목록(`[{index,code,message}]`)이 들어 있다.

### run_plan
1. **사전 검증**: 모든 단계를 검사한다 — 모르는 도구(`UNKNOWN_TOOL`), 허용되지 않는 도구(`STEP_NOT_ALLOWED`: `run_plan`, `insert_picture`, `create_document`, 편집기 화면이 필요한 명령), 입력 schema(`INVALID_INPUT`), 대상 존재(`find` 가 문서에 정확히 한 번, `occurrence` 를 주면 그 번째). 하나라도 틀리면 `{ok:false, error:{code:'PLAN_INVALID'}, result:{applied:false, invalid:[{index,code,message}]}}` 이고 문서는 바뀌지 않는다.
2. **실행**: 단계들을 순서대로 **하나의 트랜잭션**으로 적용한다 → 성공하면 `{ok:true, result:{applied:true, steps:[단계별 결과], pageCountBefore, pageCountAfter, verified}}`, **undo 1번**으로 전체가 되돌아간다.
3. **실행 중 실패**: 트랜잭션이 통째로 롤백된다(게이트가 내보낸 파일의 바이트가 같음을 확인) → `{ok:false, error:{code:'PLAN_FAILED'}, result:{applied:false, failedAt, rolledBack:true, error}}`.
4. `dryRun:true`: 사전 검증만 하고 `{ok:true, result:{applied:false, dryRun:true, valid:true, steps:[{index,tool,preview}]}}`.

실패는 `ok:false` 로 오고 `result.applied === false` 도 함께 있으므로, `ok` 만 보든 `applied` 만 보든 조용히 지나칠 수 없다.
한계: 사전 검증은 계획 시작 시점의 문서를 기준으로 한다. 앞 단계가 만들 글을 뒤 단계가 찾는 연쇄(`find` 가 앞 단계 인자의 글에 들어 있는 경우)는 실행 때 검증하고, 틀리면 전체 롤백된다. 같은 글을 두 번 바꾸는 계획도 실행 때 실패해 롤백된다.

### dryRun 옵션
`callTool(name, args, {dryRun:true})`

| 도구 | 결과 |
|---|---|
| 쓰기 도구(upstream 29개) | `{dryRun:true, applied:false, location, oldText, newText, before?, after?, format?}` — 같은 검증(대상 존재·유일·schema)을 거치되 적용하지 않는다. 문서를 건드리지 않는다. |
| `set_cells`, `fill_fields` | 바뀔 목록(`changed` / `filled`, `notFound`, `ambiguous`)만. |
| `run_plan` | 위 4번 |
| `run_command` | `DRYRUN_UNSUPPORTED` |
| 읽기 도구 | 옵션을 무시하고 그냥 읽는다. |

게이트가 dryRun 앞뒤의 문서 서명(쪽 배치 글 + 모든 표 + 본문 + 누름틀)과 내보낸 파일의 SHA-256 이 같음을 확인한다.

### verified
`replace_text`, `set_cell_text`, `set_cells`, `fill_fields`(와 `run_plan` 의 요약) 결과에 `verified: true|false` 가 붙는다. 쓴 뒤 문서를 **다시 읽어** 확인한 값이다.
`replace_text` 는 앞뒤 문맥을 포함한 새 글이 더 많이 검색되는지(또는 비운 글이 줄었는지), `set_cell_text`/`set_cells` 는 그 칸을 다시 읽어 글이 같은지, `fill_fields` 는 누름틀 목록을 다시 읽어 값이 같은지 본다.

## 공백 관용 찾기

문서의 글에는 보통 공백처럼 보여도 다른 문자(예: 숫자 공백 U+2007 「단위\u2007: 백만 달러」)가 들어 있다. 에이전트가 일반 공백으로 쓰면 못 찾던 문제를 플러그인 층에서 푼다.
`find` 와 `after` 인자를 가진 모든 도구(쓰기 도구, `select_text`, `run_plan` 의 사전 검증과 실행, `dryRun`)에 같은 규칙이 적용된다.

1. 먼저 **정확히** 찾는다. 있으면 그대로 쓴다(`normalizedMatch` 없음).
2. 정확히 하나도 없을 때만, 질의의 공백 덩어리 하나가 문서의 공백 1개 이상과 맞는 것으로 다시 찾는다. 공백은 `\s` + U+00A0, U+2000–U+200B, U+202F, U+205F, U+3000, U+FEFF. 폭 없는 문자(U+200B, U+FEFF)만 있는 덩어리는 있어도 없어도 된다. 대소문자·문장부호는 바꾸지 않는다. 공백 없는 질의는 서로 다른 낱말을 건너 맞추지 않는다. 한 문단 안에서만 맞춘다.
3. 맞은 곳의 **문서 글 그대로**를 upstream 도구에 넘기므로 `occurrence`, 모호함, 한 문단 규칙은 그대로다. 정규화로 맞은 곳이 여럿인데 `occurrence` 가 없으면 `AMBIGUOUS_TARGET`. `occurrence` 는 정규화로 맞은 곳의 순번이다.
4. 쓴 경우 결과에 `normalizedMatch: true`, `matchedText`(문서의 정확한 글)가 붙는다. `run_plan` 이면 단계 결과와 `dryRun` 미리보기에 붙는다.
5. `search_text` 는 정확 일치 결과를 그대로 돌려주되, 0건이고 공백만 다른 글이 있으면 `normalizedMatches:[{matchedText,count}]` 힌트를 붙인다.

## 「AI에게 맡기기」 버튼

메뉴 바 오른쪽(기본 도구 상자 접기 버튼 바로 앞, `#menu-bar > #cs-ai-handoff`)의 작은 버튼. 누르면 `hwpAgent.agentPrompt`(안내문)를 클립보드에 복사하고 버튼 아래에 「복사했어요」(`.cs-toast`, `role="status"`)를 잠깐 보인다.
`navigator.clipboard` 가 없거나 거절되면 숨은 textarea + `execCommand('copy')` 로 대신한다. 폭 480px 미만에서는 라벨이 「AI」로 줄어든다. 메뉴 바 높이·문서 영역 위치를 바꾸지 않는다(게이트가 확인). 플러그인은 올리지 않는다(`cs/studio/agent-tools-global.ts`).

## undo 한 번이 되돌리는 것

| 호출 | undo 스텝 |
|---|---|
| 기존 쓰기 도구 | 1 (변경 없음) |
| `set_cells` | 1 (칸이 여러 개여도) |
| `fill_fields` | 1 (쓸 것이 없으면 0 — 모두 `notFound`/`ambiguous`/같은 값) |
| `run_plan` | 1 (단계 수와 무관, 실패하면 0 — 롤백) |
| `dryRun` | 0 |

## 검사

`cd cs && npm ci && npm test` (순수 로직 단위 테스트: `studio/agent-tools-pure.test.ts`) 와 `node cs/gate/agent-tools.e2e.mjs`(헤드리스 Chromium).
게이트는 같은 문서(`samples/3-09월_교육_통합_2022.hwpx` 와 `.hwp`, 표 2개·병합 있음)로 다음을 독립 재읽기로 확인한다:
9a 표 목록/읽기 일치 + `set_cells` → 재읽기 → 내보내기 → 다시 열어 유지, 9b 병합에 덮인 칸 `COVERED_BY_MERGE` 와 문서 불변(서명 + 바이트), 9c `fill_fields`(있는 이름/없는 이름/중복 이름/순번/undo), 9d `run_plan`(잘못된 단계 1개 → 변경 0, 올바른 3단계 → 적용 → undo 1번에 원복, 실행 중 실패 → 롤백), 9e dryRun 불변, 9f `help()`·`listTools`·`hwpAgent`·meta, 9g 지연 로드와 WebMCP, 10 공백 관용 찾기(`samples/156636617_240617 2024년 5월 월간 수출입 현황(확정치).hwp` 의 U+2007), 11 「AI에게 맡기기」 버튼(클립보드, 대체 경로, 좁은 폭, 레이아웃 불변).

## 알려진 한계

- 표는 본문 1단계 표만 센다. 칸 안 중첩 표, 글상자 안 표는 `list_tables` 에 없다.
- `set_cells` 는 한 문단짜리 칸만 쓴다. 여러 문단 칸은 `MULTI_PARAGRAPH_CELL`.
- 쪽 배치 글(`read_page_text`)의 `[table N / cell M]` 번호는 그 쪽 안의 번호라 `list_tables` 의 `table` 과 다르다. 머리말 표 등이 쪽마다 되풀이된다.
- 사전 검증은 계획 시작 시점의 문서 기준이다(위 한계 참고).
