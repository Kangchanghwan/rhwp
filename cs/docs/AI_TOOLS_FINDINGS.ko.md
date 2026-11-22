# AI 도구를 채팅/LLM/승인 카드 없이 직접 호출할 수 있는가 — 조사 결과

경로는 `rhwp-studio/src/ai/` 기준(별도 표기 없으면). v0.9.1(`cs/main`) 코드를 읽기만 했고 빌드·실행 검증은 하지 않았다.

## 결론 (먼저)

**예, 사실상 가능하다 (yes, 단 "승인 UI"가 하는 두세 가지 일을 우리 코드가 대신해야 함).**
- 도구 3개 모듈(`tools/read-tools.ts`, `write-tools.ts`, `command-tools.ts`)은 `PluginHost` 의 부분집합(`read`, `transaction`, `createBlankDocument`, `getSelectionText`, `getCaret`, `selectTextRange`, `automation`)만 요구한다. `AiContext`·설정·API 키·네트워크·DOM 에 의존하지 않는다.
- "승인"은 도구 쪽이 아니라 `ChatController.executeWrite` + `AiPanel` 카드(UI)가 하는 일이다. 도구는 `prepareWrite()` 로 "제안(WriteProposal)"을 돌려주고 `proposal.apply()` 를 부르면 적용된다. 직접 `apply()` 를 부르면 승인 카드 없이 곧바로 적용이다.
- 예외: `insert_picture`(사용자 파일 선택 필요)는 우리가 파일 바이트를 대신 넘겨야 하고, `create_document` 는 저장 안 된 변경 확인 대화상자가 뜰 수 있다.

## 1. 도구 목록과 스키마

총 **41개 = 읽기 8 + 쓰기 30 + 명령 3**. 이름 정확한 목록:

| 그룹 | 개수 | 이름 | 정의 위치 |
|---|---|---|---|
| 읽기 | 8 | `get_document_info`, `get_outline`, `read_page_text`, `read_paragraphs`, `search_text`, `get_selection`, `list_fields`, `list_charts` | `tools/read-tools.ts:136,151,175,204,259,307,328,357` (배열 `READ_TOOLS` :134, 비공개 const) |
| 쓰기 | 30 | `replace_text`, `fill_field`, `insert_paragraphs`, `format_text`, `format_paragraph`, `insert_table`, `delete_paragraph`, `set_list`, `apply_style`, `edit_table`, `set_cell_text`, `set_header_footer`, `insert_footnote`, `replace_all`, `format_cell`, `page_setup`, `set_table_border`, `set_cell_size`, `insert_hyperlink`, `add_bookmark`, `insert_equation`, `set_columns`, `insert_picture`, `insert_textbox`, `insert_shape`, `new_page_number`, `set_page_border`, `insert_field`, `set_chart_data`, `create_document` | `tools/write-tools.ts:608-805 WRITE_TOOL_DEFS`, 이름 목록 `:806 WRITE_TOOL_NAMES`, 타입 `:148 WriteToolName` |
| 명령 | 3 | `list_commands`, `select_text`, `run_command` | `tools/command-tools.ts:96-118 COMMAND_TOOL_DEFS` |

- 스키마 정의 방식: 손으로 쓴 **JSON Schema 부분집합** 객체(`ToolSchema`, `tools/schema-validate.ts:12-31`; `type:'object'`, `properties`, `required`, `additionalProperties:false`; 필드는 integer/number/string(enum, min/maxLength)/boolean/문자열 배열). 읽기는 `READ_TOOLS[].schema`, 쓰기는 `WRITE_SCHEMAS: Record<WriteToolName, ToolSchema>`(`write-tools.ts:200` 부근, 비공개), 명령은 `SELECT_SCHEMA`/`RUN_SCHEMA`/`LIST_SCHEMA`.
- 외부에 공개되는 목록: `READ_TOOL_DEFS`(read-tools.ts:366), `WRITE_TOOL_DEFS`, `COMMAND_TOOL_DEFS` — 모두 `AiToolDef {name, description, inputSchema, strict?}` (`provider/types.ts:59`) 배열이고 `export` 되어 있다. 합친 `AI_TOOL_DEFS`(`agent/chat-controller.ts:38`)는 읽기→쓰기→명령 순(프롬프트 캐시 접두 유지용). 우리는 chat-controller 를 import 하지 말고 세 DEFS 를 직접 합친다.
- 설명 문구는 영어(모델용), 코드 주석은 한국어. 일부 쓰기 도구 description 에 "Shown to the user for approval" 같은 승인 전제 문구가 있다 — 자동 승인 환경에서는 무해하지만 외부 에이전트용 목록에서는 문구를 정리해도 된다.
- 허용 커맨드(`run_command`): `AI_ALLOWED_COMMANDS` (`command-tools.ts:19`) 41개 허용 목록(서식·정렬·쪽나누기·표 행열·각주 등)만 실행된다.

## 2. LLM 도구 호출 → 문서 변경 경로

현재 경로(`agent/chat-controller.ts`)
```
runAgent (agent-loop.ts) 가 모델의 tool_use 를 받으면 executeTool(call, boundaryId, signal) 호출 (chat-controller.ts:132-140)
  ├ isWriteTool(name)   → this.executeWrite(call, boundaryId, signal, host => prepareWrite(host, call))   (:137, 구현 :160-247)
  ├ isCommandTool(name) → executeCommandTool  (:155)  list_commands/select_text 는 즉시, run_command 는 executeWrite 경유
  └ 그 외(읽기)         → executeReadTool(toolHost, call, boundaryId)  (:139)
executeWrite:
  1) writeHost = { read, transaction, createBlankDocument } 를 PluginHost 에서 조립 (:165-176)
  2) proposal = prepare(writeHost)                      // 입력 검증(validateToolInput) + 대상 위치 탐색, 문서는 아직 안 바뀜
  3) presenter.present(proposal, {autoApply, signal})   // ← UI. 승인 카드 / autoApply 이면 즉시 true  (:198)
  4) await proposal.apply()                              // ← 실제 변경, host.transaction 1회  (:215)
  5) 결과 {applied:true, location, newText, note?} 를 문서 경계로 감싸 반환
```
필요한 객체(직접 호출 시)
| 호출 | 필요한 것 | 시그니처 |
|---|---|---|
| 읽기 | `ToolHost` = `{read, getSelectionText, getCaret}` — **`PluginHost` 를 그대로 넘기면 된다** | `executeReadTool(host: ToolHost, call: AiToolCall, boundaryId: string): AiToolResult` (`read-tools.ts:383`, 동기, 던지지 않고 `isError` 로 반환) |
| 쓰기 | `WriteHost = {read, transaction, createBlankDocument(): Promise<boolean>}` (`write-tools.ts:141`) | `prepareWrite(host: WriteHost, call: AiToolCall): WriteProposal` (`:2117`, 거절은 `WriteRefused` 던짐) → `proposal.apply(): void \| Promise<void>` |
| 명령 | `CommandHost` = `{read, selectTextRange, getSelectionText, automation:{listCommands,isEnabled,execute}}` (`command-tools.ts:54`) | `listAllowedCommands(host)`, `selectText(host, call)`, `prepareCommand(host, call): WriteProposal` |
- `AiToolCall = {id, name, input}` (`provider/types.ts:70`). `boundaryId` 는 `createBoundaryId()`(`tools/untrusted.ts:13`)로 만든 난수 hex.
- 결과 포장: 읽기 결과는 `<document_content id="…">{JSON}</document_content id="…">` 문자열(`untrusted.ts:26`)이다. LLM 주입 방어용 경계이므로 외부 에이전트에겐 `JSON.parse` 가능한 본문만 꺼내거나(경계 사이의 줄), 또는 `encodeUntrustedJson` 을 안 거치고 직접 `READ_TOOLS` 를 쓰고 싶지만 `READ_TOOLS` 는 비공개이므로 경계 제거 후 파싱이 가장 쉽다. 단, 문서 텍스트는 외부에 신뢰 불가 데이터라는 점은 그대로다.

`autoApply` 의 정체
- `AiSettings.autoApply`(`settings/ai-settings.ts:24`, 기본 false) 와 `applyRestOfRun`(`chat-controller.ts:88`, 카드의 "이번 응답 모두 적용")이다. 컨트롤러는 이를 `presenter.present(..., {autoApply})` 에 넘기기만 하고(:198), 실제 분기는 UI 가 한다(`ui/ai-panel.ts:237,248`: autoApply 면 `decide(true)`). 즉 도구·컨트롤러 안에는 승인 게이트가 없고, **`apply()` 를 직접 부르면 곧 auto-apply** 다. 설정 저장소/API 키 불필요.

undo 단위
- 쓰기 도구 28개는 `apply` 안에서 `host.transaction('AI: <라벨>', …)` 을 **정확히 1번** 호출한다(`write-tools.ts` 의 `host.transaction(` 28곳: 887, 944, 1023 … 2092). `transaction` 은 `PluginHostFacade.transaction`(`plugin/host.ts:112`)이며 `executeOperation({kind:'snapshot', operationType:'plugin:<pluginId>:<label>'})` 이라 **도구 1회 호출 = undo 1스텝 = 재조판 1회**, 실패 시 롤백, 중첩 시 `NESTED_TX`.
- 예외 2개: `create_document`(트랜잭션 없음; `createBlankDocument` 로 문서 교체 → undo 이력 초기화) 와 `run_command`(`automation.execute` → 기존 `CommandDispatcher` 가 자체 undo 단위를 만든다).
- 라벨이 `plugin:<id>:AI: …` 로 기록되므로, 우리가 별도 플러그인 id(`cs-agent-tools`)로 호출하면 이력에 우리 id 로 남는다.

## 3. 채팅 UI·네트워크·키 의존성 점검

`tools/*.ts` 의 import 전수(조사 결과):
- `read-tools.ts`: `@/plugin/types`(타입), `../provider/types.ts`(**import type**), `./schema-validate.ts`, `./untrusted.ts`, `./write-tools.ts`(`listCharts`)
- `write-tools.ts`: `../provider/types.ts`(import type), `./schema-validate.ts`, `./untrusted.ts`
- `command-tools.ts`: `@/plugin/types`(타입), `../provider/types.ts`(import type), `./schema-validate.ts`, `./untrusted.ts`, `./write-tools.ts`(`WriteRefused`)
- `schema-validate.ts`, `untrusted.ts`: import 없음.
→ **DOM, i18n, 설정, 키 저장소, 제공자 SDK, fetch 전부 없음.** 값(런타임) import 는 도구 모듈끼리와 `plugin/types.ts`(타입만)뿐이다. `provider/types.ts` 는 `import type` 이라 컴파일 때 지워진다. `@anthropic-ai/sdk` 는 `provider/claude.ts` 에서만 쓰인다.
- 키/네트워크가 필요한 곳: `ChatController.ask()`(`chat-controller.ts:102` 부근 `keyStore.getKey`, `providerFactory`)뿐. 도구는 무관.
- 채팅 UI 전용: `AiPanel`(`ui/ai-panel.ts`)이 `ProposalPresenter` 구현과 파일 선택(`readPickedImage` :82)을 갖는다.
- `ai/` 바깥에서 `ai/tools` 를 import 하는 모듈은 없다(`grep -rn "from '@/ai"` 결과 `main.ts` 의 동적 import 뿐). 그래서 분리 재사용이 쉽다.

## 4. `RHWP_WITHOUT_AI=1` / `__RHWP_AI__` 와 번들, 패널 로딩

- `vite.config.ts:27 withAi = process.env.RHWP_WITHOUT_AI !== '1'`, `:38 __RHWP_AI__: JSON.stringify(withAi)`.
- `main.ts:345-347`: `if (__RHWP_AI__ && id === 'ai-assistant') return (await import('@/ai/plugin')).aiAssistantPlugin;` — AI 코드로 가는 **유일한** 정적/동적 참조. `false` 면 분기가 제거돼 `ai/plugin.ts → chat-controller → tools/provider/ui` 전체가 도달 불가 → 청크·SDK 모두 빠진다. 즉 tools 모듈도 같이 빠진다(**withoutAiStripsTools = true**, 정적 분석 기준. 실제 빌드 산출물로는 확인 안 함). 그래서 우리 플러그인이 tools 를 쓰려면 **우리 플러그인이 tools 를 직접 import** 해야 하고(그러면 `__RHWP_AI__` 와 무관하게 번들에 남음), AI 패널은 끄고(`RHWP_WITHOUT_AI=1`) 도구만 남길 수 있다.
- 패널 로딩: `main.ts:2306-2308` — `initPromise.then(...)` 안에서 `if (__RHWP_AI__ && sidePanels && window.parent === window) plugins.load('ai-assistant')`. 조건 3개: 빌드 포함, 사이드 패널 존재(embed 모드 아님: `main.ts:358`), **최상위 창**(iframe 이 아님). 우리 서비스가 hwp 에디터를 iframe 으로 넣으면 이미 패널은 자동 로드되지 않는다. 최상위 창으로 쓸 거면 `RHWP_WITHOUT_AI=1` 로 패널을 없애면 된다.
- `ai-assistant` 가 로드되면 `activate` 에서 `AiContext.create()`(IndexedDB 열기), 사이드 패널 등록(처음엔 닫힘 — `SidePanelController` 는 `toggle` 로만 열림), `ext:ai.toggle-panel`·`ext:ai.settings` 커맨드와 「도구」 메뉴 항목 2개 추가(`ai/plugin.ts:29-60`).
- 정리: 패널을 숨기는 가장 단순한 방법 = `RHWP_WITHOUT_AI=1` (메뉴 항목·IndexedDB 접근·제공자 SDK 모두 사라짐). 다른 방법(AI 를 포함한 채 숨기기)은 `plugins.unload('ai-assistant')` 를 호출하거나 CSS 로 숨기는 것인데, 둘 다 번들 크기에 이득이 없어 비추천.

## 5. 설계: 내장 플러그인 `cs-agent-tools`

### 5.1 파일 배치
```
cs/studio/agent-tools-plugin.ts   # StudioPlugin 정의 (id 'cs-agent-tools'), 표면: listTools / callTool / (선택) describe
cs/studio/agent-tools-core.ts     # 순수 로직: 도구 목록 합치기, 호출 디스패치, 결과 변환, 직렬 큐 (host 인터페이스만 의존 → 단위 시험 쉬움)
cs/studio/picked-image.ts         # PickedFile 만들기 (base64/dataURL → bytes + naturalWidth/Height, ai-panel.ts:82 readPickedImage 와 같은 규칙으로 재구현)
cs/PATCHES.md                     # 원본 패치 1줄 기록
```
`ai/ui/ai-panel.ts` 는 CSS·i18n·dialog 를 끌고 오므로 import 하지 않는다(그 안의 `readPickedImage` 만 재구현).

### 5.2 upstream 최소 패치 (파일 1개, 1~2줄)
`rhwp-studio/src/main.ts` `resolvePlugin()` (:336-352) 에서 `throw` 바로 앞에 추가:
```ts
if (id === 'cs-agent-tools') return (await import('../../cs/studio/agent-tools-plugin')).csAgentToolsPlugin;   // [cs]
```
- `__RHWP_AI__` 분기 **밖**에 둔다(그래야 `RHWP_WITHOUT_AI=1` 빌드에서도 살아 있음). 동적 import 라 별도 청크가 되고, 로드하지 않으면 실행되지 않는다. 
- 필요하면(자동 로드) `main.ts:2306` 블록 뒤에 `plugins.load('cs-agent-tools')` 1줄 — 호스트가 `plugin.load` 를 부르게 하면 불필요하므로 비권장.
- (개발 서버용) `vite.config.ts` `server.fs.allow` 에 `resolve(configDir, '..', 'cs')` 1줄. 프로덕션 `vite build` 에는 불필요. 이 한 줄이 싫으면 dev 에서도 `vite build --watch` 로 쓰거나 저장소 루트를 workspace root 로 인식시킨다(미검증).
- `tsconfig` 의 `include:["src"]` 밖 파일이지만 import 로 따라가므로 `tsc` 통과 가능. 단 `cs/` 안에서 `@/…` alias 는 tsconfig paths 로 풀리고 vite alias 도 같은 `@` → 문제없음(상대경로 `../../rhwp-studio/src/...` 로 써도 된다). 이 부분은 실제 `npm run build` 로 확인 필요.

### 5.3 표면(Surface) 설계
```ts
// cs/studio/agent-tools-plugin.ts (개략)
import type { PluginHost, StudioPlugin } from '@/plugin/types';
import { PLUGIN_API_VERSION } from '@/plugin/types';
import { READ_TOOL_DEFS, executeReadTool } from '@/ai/tools/read-tools';
import { WRITE_TOOL_DEFS, isWriteTool, prepareWrite, WriteRefused } from '@/ai/tools/write-tools';
import { COMMAND_TOOL_DEFS, isCommandTool, listAllowedCommands, selectText, prepareCommand } from '@/ai/tools/command-tools';
import { createBoundaryId } from '@/ai/tools/untrusted';

export const csAgentToolsPlugin: StudioPlugin = {
  id: 'cs-agent-tools',
  apiVersion: PLUGIN_API_VERSION,
  activate(host: PluginHost) {
    const defs = [...READ_TOOL_DEFS, ...WRITE_TOOL_DEFS, ...COMMAND_TOOL_DEFS];
    let queue: Promise<unknown> = Promise.resolve();             // 호출 직렬화 (NESTED_TX·동시 변경 방지)
    const writeHost = { read: (fn) => host.read(fn), transaction: (l, fn) => host.transaction(l, fn),
      createBlankDocument: () => host.createBlankDocument({ confirmUnsaved: false }) };   // 아래 6항 참고
    return {
      listTools: () => defs.map(d => ({ name: d.name, description: d.description, inputSchema: d.inputSchema,
                                         group: READ.has(d.name) ? 'read' : WRITE.has(d.name) ? 'write' : 'command' })),
      callTool: (name: string, args: unknown, opts?: { file?: {...} }) => enqueue(() => run(name, args ?? {}, opts)),
    };
  },
};
```
`run` 의 분기(= `chat-controller.ts:137-139,155` 를 UI 없이 옮긴 것):
1. `isWriteTool(name)` → `const p = prepareWrite(writeHost, {id, name, input}); if (p.file) { 파일 없으면 {ok:false, error:'FILE_REQUIRED'}; p.file.provide(picked) } await p.apply(); return {ok:true, applied:true, location:p.location, newText:p.inserted, note:p.note}`. 던져진 `WriteRefused` → `{ok:false, error:message}`, `StudioCommandError` 는 `await error.report` 후 사유 반환(`chat-controller.ts:219-226` 와 같은 규칙).
2. `name === 'run_command'` → `prepareCommand(host, call).apply()`; `list_commands` → `listAllowedCommands(host)`; `select_text` → `selectText(host, call)`.
3. 그 밖의 읽기 → `executeReadTool(host, call, createBoundaryId())` 결과 `content` 에서 `<document_content …>` 경계를 벗겨 `JSON.parse` 한 값을 `{ok, result}` 로 반환 (문서 텍스트는 비신뢰 데이터임은 문서화).
- 반환값은 JSON 직렬화 가능한 객체만(embed 의 구조화 복제 조건).
- 모든 문서 호출은 `PluginHost` 를 통해서만(직접 `wasm` 접근 없음) → undo·세대 검사·편집 모드 게이트가 그대로 적용.

### 5.4 호출 경로
- 같은 페이지 JS: `await window.rhwpStudio.plugins.load('cs-agent-tools'); await window.rhwpStudio.plugins.invoke('cs-agent-tools','callTool',['replace_text',{find:'…',replace:'…'}])` (`PluginHostRegistry.invoke`, `plugin/host.ts:406`; async 면 Promise 반환). 편의로 플러그인 `activate` 안에서 `(window as any).rhwpStudio.csAgent = surface` 를 심어도 된다(우리 파일 안에서만 하면 upstream 패치 불필요).
- iframe 부모 → embed RPC(`embed/rpc-router.ts:215-220`): `plugin.load {id:'cs-agent-tools'}` → `plugin.invoke {id:'cs-agent-tools', method:'listTools', args:[]}` / `{method:'callTool', args:['replace_text', {…}]}`. 핸들러 `pluginInvoke`(`main.ts:2444`)는 `initPromise` 를 기다린 뒤 `plugins.invoke` 를 반환하므로 Promise 결과도 그대로 응답된다. 인자·결과는 구조화 복제 가능한 데이터만(Uint8Array 는 transferable).
- 보안 주의: embed 의 신뢰 경계는 "http/https 부모 origin 첫 연결에 바인딩"뿐이다(`embed/runtime.ts:183-193`, `protocol.ts:111`). `cs-agent-tools` 를 올리면 그 부모가 **문서를 마음대로 수정**할 수 있게 되므로, 운영 배포(hwp.clipboardapp.org)에서는 이 플러그인을 항상 켜 두지 말고 호스트가 필요할 때 `plugin.load` 하게 하고, origin 제한(허용 origin 목록)을 우리 쪽에서 추가하는 것을 검토.

## 6. 헤드리스로 못 도는/주의할 도구

| 도구 | 문제 | 처리 |
|---|---|---|
| `insert_picture` | `prepareWrite` 가 돌려주는 `proposal.file`(accept: png/jpeg/gif/bmp)에 사용자가 고른 `PickedFile{name, bytes, extension, naturalWidth, naturalHeight}` 를 `provide` 해야 한다. 없으면 `apply()` 가 `WriteRefused('The user did not choose a picture file.')` (`write-tools.ts:1875-1900`) | `callTool(name,args,{file:{name,dataBase64}})` 로 받아 `createImageBitmap`/`Image` 로 크기 읽고 `provide`. 파일 없으면 명시적 오류. 확장자는 png/jpeg/gif/bmp 로 제한 |
| `create_document` | `createBlankDocument({confirmUnsaved:true})` 가 "저장 안 된 변경" 대화상자를 띄울 수 있고, 취소 시 `WriteRefused`. 문서가 교체되어 lease·undo 이력 초기화 | 자동화에서는 `confirmUnsaved:false` 로 호출하거나 아예 도구 목록에서 제외(권장: 제외하고 호스트의 `loadFile` 사용) |
| `run_command` | `automation.execute` 가 `opensDialog` 커맨드면 대화상자가 뜨지만 허용 목록은 대화상자 없는 것만(`command-tools.ts:19-41`). 현재 선택/캐럿 필요 → `select_text` 선행. `isEnabled` 가 false 면 거절 | `select_text` → `run_command` 를 한 번에 묶는 상위 도구를 둘 수도 있음(선택). 호출 사이에 사용자가 선택을 바꾸면 `apply()` 가 거절(:207-210) |
| `select_text`/`get_selection` | 실제 편집기 선택을 움직임(`selectTextRange` → `navigateToSearchHit` → 스크롤) — 화면 없는 환경(embed+숨김)에서는 `false` | 화면이 있는 구성에서만 사용 |
| `read_page_text`, 일부 쓰기(`insert_shape`, `insert_textbox`) | `getPageTextLayout` 등 렌더 결과를 사용 → 렌더러 초기화 이후만 가능 | 문서 로드 완료(`ready`/`getDocumentState`) 후 호출 |
| 동시 호출 | 트랜잭션 중첩은 `NESTED_TX` | 플러그인 내부 직렬 큐 |

## 7. 위험 / 미확인

- **미검증**: 실제로 `cs/` 에서 상대경로 동적 import 가 `tsc && vite build` 를 통과하는지, 청크가 분리되는지, `RHWP_WITHOUT_AI=1` 빌드에서 tools 가 우리 청크에만 들어가는지 — 빌드를 돌려 `dist/assets` 로 확인해야 한다(`pkg/` 가 없어 이번 조사에서 빌드 불가).
- **업스트림 변경 위험**: `ai/tools/*` 의 export 이름·시그니처는 v0.9.1 기준이며 내부 API 다(AI 도우미 P0 구현 중, 파일 헤더가 계획서를 가리킴). 업스트림이 `READ_TOOLS` 를 바꾸거나 `WriteHost` 에 필드를 추가하면 우리 어댑터가 깨진다 → 어댑터를 얇게 두고 타입 검사(`tsc`)와 도구 목록 스냅샷 시험(41개 이름)을 CI 에 넣는다.
- **스키마 한계**: `ToolSchema` 는 부분집합이며 서버 strict 검증은 없다. 외부 에이전트가 보낸 입력은 `prepareWrite`/`executeReadTool` 안의 `validateToolInput` 이 한 번 검증한다(안전). 그러나 오류 문구가 영어·모델 지향이다.
- **프롬프트 주입**: 읽기 결과는 문서 본문이다. 외부 LLM 에 그대로 먹일 때 경계 태그를 유지할지 결정해야 한다(유지하려면 벗기지 말고 문자열 그대로 반환하는 옵션 필요).
- **승인 UX 상실**: 자동 적용이므로 되돌림은 undo(Ctrl+Z, 호출당 1스텝) 에만 의존한다. 대량 호출 시 undo 스냅샷 예산(`history.ts snapshotCapacity`)에 닿을 수 있다 — 연속 `callTool` 이 많을 때 `e2e:undo-depth` 계열 한도를 확인.
- **문서 교체 경합**: 호출 도중 문서가 바뀌면 `DOCUMENT_RELEASED` 가 던져진다(`isDocumentReleased`). 어댑터가 `{ok:false, error:'DOCUMENT_RELEASED'}` 로 변환.
- **임베드 보안**: 5.4 참고(origin 화이트리스트).
- **미조사**: `write-tools.ts` 30개 각각의 입력 필드 전부, 개별 도구의 한계(예: 중첩 표·글상자 안 편집)는 읽지 않았다. 도구별 실제 동작은 `cs/` 에 e2e 를 만들 때 샘플 문서로 확인할 것.
