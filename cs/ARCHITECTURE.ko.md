# rhwp 아키텍처 지도 (유지보수자용, v0.9.1 기준)

> 읽기 전용 코드 조사 결과. 경로는 저장소 루트(`~/Documents/personal/rhwp`) 기준, 줄 번호는 `cs/main`(= upstream v0.9.1 + `cs/`) 시점이다.
> 상세 설계 문서는 sparse checkout 으로 빠져 있다: `git show v0.9.1:mydocs/<경로>` 로 읽는다.
> (CLI/MCP 쪽 표면은 `git show v0.9.1:mydocs/manual/agent_knowledge_map.md` 가 단일 진입점.)

## 1. 한눈에 보기

```
 .hwp / .hwpx / (.hml, .hwp3, PDF) 바이트
        │
        ▼
 src/parser/        CFB·레코드·HWPX(XML) 파서  ── parse_document()  (src/lib.rs 가 재노출)
        │
        ▼
 src/model/         Document / Section / Paragraph / Control / Table / Shape …  (순수 데이터 IR)
        │
        ▼
 src/document_core/ DocumentCore — 편집(commands/)·조회(queries/)·재조판 트리거의 본체
        │             ├─ commands/  text_editing, formatting, table_ops, object_ops, header_footer_ops …
        │             └─ queries/   cursor_rect, search_query, field_query, rendering, table_extract …
        ▼
 src/renderer/      조판(pagination, composer, layout) → 쪽별 레이어(paint/) → SVG/Canvas/CanvasKit 레이어 트리
        │
        ▼
 src/wasm_api.rs    #[wasm_bindgen] HwpDocument — DocumentCore 를 JS 로 노출 (10,667줄, 하위 파일은 src/wasm_api/)
        │             wasm-pack 산출물 = pkg/rhwp.js + pkg/rhwp_bg.wasm
        ▼
 rhwp-studio/src/core/wasm-bridge.ts   WasmBridge — 문서 핸들 소유자(세대 generation 관리), 유일한 WASM 호출 통로
        │
        ▼
 rhwp-studio/src/engine/   InputHandler(캐럿·선택·키보드/마우스/IME) + CommandHistory(undo/redo) + 렌더 오버레이
        │
        ▼
 rhwp-studio/src/command/ + ui/ + view/ + main.ts   커맨드 레지스트리·디스패처, 메뉴/툴바/대화상자, 캔버스 뷰
        │
        ├─ 바깥 창구: window.rhwpStudio / AutomationHost / embed RPC / document-agent / plugin
        ▼
 저장: command/commands/file.ts → save-document-format.ts → WasmBridge.exportHwp/exportHwpx
        → wasm_api.rs export_hwp / export_hwpx → src/serializer/ (cfb_writer, hwpx, doc_info, body_text …) → 바이트
```

핵심 불변식(코드 주석에 반복해서 나옴)
- JS 쪽에서 WASM 문서를 직접 `new HwpDocument` 로 만들지 않는다. 문서는 `WasmBridge` 가 하나만 소유하고, 플러그인은 "빌린 핸들(lease)"만 쓴다 (`rhwp-studio/src/plugin/types.ts:16-31`).
- 문서를 바꾸는 모든 경로는 `InputHandler.executeOperation → CommandHistory` 를 지나야 undo 가 성립한다 (`engine/input-handler.ts:3321`, `plugin/host.ts:112-165`).
- 렌더 경로: Studio 는 WASM 이 만든 레이어 트리를 Canvas2D 또는 CanvasKit 로 그린다(`view/canvas-view.ts`, `view/canvaskit-renderer.ts`).

## 2. "열기 → 고치기 → 저장" 호출 사슬

### (a) .hwp/.hwpx 열기 (studio)

| 단계 | 파일:줄 | 설명 |
|---|---|---|
| 진입점 | `command/file-open-picker.ts`, 드롭 핸들러(`main.ts` ~1116), `?url=`(`main.ts:959`), 자동저장 복구(`main.ts:2052`), 호스트 API `plugins.loadDocument`(`main.ts:371`), embed `loadFile` | 전부 `loadBytes` 로 모인다 |
| 깔때기 | `main.ts:1819 loadBytes()` | AbortSignal, PDF 분기, 진행 표시, `withBusyCursor` |
| 파싱 | `main.ts:1726 loadDocumentForOpen()` → `core/wasm-bridge.ts:568 loadDocument()` → `:519 loadDocumentAtomically()` | 새 `HwpDocument` 를 만들고 성공해야만 교체(원자 교체, 문서 세대 +1, 이전 문서 free). 암호 문서는 `loadDocumentWithPassword`(:626) |
| WASM | `wasm_api.rs:435 struct HwpDocument`, `:507 from_bytes` → `DocumentCore::from_bytes` → `parser::parse_document` | 포맷 판별(HWP5 CFB / HWPX zip / HML / HWP3) 후 `model::Document` 생성, 첫 조판 |
| 뷰 준비 | `main.ts` `prepareCanvasRendererDocument()` → `view/canvas-view.ts` | 쪽 목록·캔버스 풀 초기화 |
| 알림 | `main.ts` `plugins.notifyDocumentSwap()` (1864, 2080 부근) | 플러그인의 lease 갱신 (`plugin/host.ts` `notifySwap`) |

### (b) 글 한 번 고치기 — 타이핑과 `replaceText`

타이핑(사용자 입력)
1. `engine/input-handler-text.ts` (IME 포함) → `InputHandler.executeOperation({kind:'command', command: new InsertTextCommand(...)})` (`engine/input-handler.ts:3321`; 여러 호출부 2126·2254·2433 …).
2. `executeOperation` 이 편집 모드 게이트(`isOperationAllowedInEditMode`, 양식 모드 차단)를 확인 후 `this.history.execute(cmd, wasm)` — `engine/history.ts CommandHistory`.
3. `engine/command.ts:690 InsertTextCommand` → `:490 insertTextWithMutationEffects` → `WasmBridge.insertText / insertTextInCell…` → `wasm_api.rs:1887 insert_text`(js 이름 `insertText`) → `document_core/commands/text_editing` → 재조판.
4. 커밋 후 `eventBus` 이벤트(`document-agent-changed` 등) → 캔버스 재렌더, 캐럿 갱신.
- undo/redo: `CommandHistory.undo()/redo()`. 일반 커맨드는 역연산, `kind:'snapshot'` 연산은 WASM 스냅샷으로 복원(`history.ts` 의 `snapshotCapacity`·`snapshotIdBudget`).

플러그인/AI 의 `replaceText`
1. 플러그인 → `host.transaction(label, tx => tx.doc().replaceText(sec,para,off,len,text))` (`plugin/host.ts:112`).
2. 내부에서 `ih.executeOperation({kind:'snapshot', operationType:'plugin:<id>:<label>', operation})` → **트랜잭션 1건 = undo 1스텝 = 재조판 1회**. 본문이 던지면 진입 시점으로 롤백, 중첩 호출은 `NESTED_TX` 로 거절, `tx.deferPagination()` 으로 조판 미룸.
3. `wasm_api.rs:6480 replace_text`(js `replaceText`) → `document_core::replace_text_native`.

### (c) 저장 / 내보내기

| 경로 | 파일:줄 |
|---|---|
| 메뉴·단축키 저장 | `command/commands/file.ts` → `command/save-target.ts`, `save-format.ts`, `save-document-format.ts:41`(형식에 따라 `exportHwpx()` 또는 `exportHwp()`) |
| 브리지 | `core/wasm-bridge.ts:782 exportHwp()`, `:824 exportHwpx()`, `:831 exportHwpxWithReport()`(내용 손실 보고, #4430), 암호 버전 `exportHwpxWithPassword` |
| WASM | `wasm_api.rs:7820 export_hwp`, `:7860 export_hwpx` → `export_*_native` → `src/serializer/` (`mod.rs serialize_document`, `cfb_writer*`, `doc_info*`, `body_text.rs`, `hwpx/`, `hml/`, `content_loss.rs`) |
| 파일 쓰기 | `command/file-system-access.ts`(File System Access API) 또는 다운로드; 저장 완료 후 더티 상태 해제 `core/document-dirty-state.ts`, 호스트 저장은 `window.rhwpStudio.notifySaved()` / embed `notifySaved` |
| 외부(embed)에서 바이트 받기 | RPC `exportHwp` / `exportHwpx` / `exportHml` / `exportHwpVerify` (`embed/rpc-router.ts:178-182`) — `Uint8Array` 는 transferable 로 전달(`embed/runtime.ts postPortResponse`) |

## 3. Rust 엔진 모듈 표 (`src/`)

편집기와 직접 관련 있는 것

| 모듈 | 역할 |
|---|---|
| `lib.rs` | 모듈 선언, `parse_document`·`serialize_document`·`DocumentCore` 재노출, `version()`·panic hook(`wasm-api` feature 가 켜졌을 때만 wasm export) |
| `parser/` | HWP5(cfb_reader, record, doc_info, body_text, control), `hwpx/`, `hml/`, `hwp3/`, `pdf/`(PDF 가져오기), `ingest/`, `crypto.rs`(암호 문서) |
| `model/` | 문서 IR: `document.rs`, `paragraph/`, `control/`, `table/`, `shape/`, `style.rs`, `page.rs`, `header_footer.rs`, `footnote.rs`, `bin_data.rs`, `event.rs`(DocumentEvent) |
| `document_core/` | `DocumentCore` 본체. `commands/`(text_editing, formatting, table_ops, object_ops, footnote_ops, header_footer_ops, section_ops, clipboard, html_import …), `queries/`(cursor_rect, search_query, field_query, rendering, table_extract, chart_*, injection_scan, pii_scan …), `builders/`, `converters/`, `hwpjson/`, `table_calc/` |
| `renderer/` | 조판·쪽 나누기·폰트 메트릭·이미지/도형/수식(`equation/`)·`layout/`·`pagination/`·`composer/`·`font_*`(수십 개). 쪽 레이어 트리(`layer_renderer.rs`)를 만든다 |
| `paint/` | 시각 레이어 IR(그리기 명령 트리) |
| `render_backend/` | 출력 백엔드 공통 계약(`RenderBackend`) |
| `serializer/` | HWP5/HWPX/HML 쓰기. `content_loss.rs` 가 내보내기 손실 보고 |
| `wasm_api.rs` + `wasm_api/` | `HwpDocument` wasm-bindgen 파사드. 하위: bitmap_raster, canvas_metrics, form_action, hyperlink, layer_export, pdf_import, template_automation, table_cell_bboxes … |
| `service/` | CLI·MCP·WASM 이 같이 쓰는 문서 열기/조회 축 |
| `emf/`, `wmf/`, `eps.rs`, `ole_chart/` | 내장 그림·차트 변환(렌더에 필요) |
| `error.rs`, `storage.rs`, `diagnostics/`, `schema_registry.rs` | 에러 타입, 요청 저장소, 진단 |
| `agent/` | 에이전트용 문서 조작 커널(선택자·연산 대수·앵커·트랜잭션) — CLI/MCP 가 쓰며 studio AI 도구와는 별개 |

웹 편집기와 무관(네이티브/CLI/MCP/서명·감사 계열)

| 모듈 | 비고 |
|---|---|
| `main.rs`, `cli/`, `bin/rhwp-q`, `bin/rhwp-agent` | CLI 바이너리 (`required-features = ["wasm-api"]`) |
| `mcp_serve.rs` | MCP 서버 |
| `native_host/`, `resource_supervisor*` | 네이티브 전용(`cfg(not(wasm32))`) |
| `pdf_runtime.rs`, `pdf_support.rs` | PDF 가져오기 한도/지원 선언 (가져오기는 wasm 에도 일부 포함: `pdf-import` feature, 기본 ON) |
| `signing` 계열: `capsule_sign.rs`, `pq_sign.rs`, `agent_seal.rs`, `anchor_log.rs`, `lineage_bundle.rs`, `policy_gate.rs`, `audit_standard.rs`, `disclose.rs`, `settle.rs`, `security_trailer.rs` | 서명·봉인·감사·공개 축. 편집기 경로에 없음 |
| `agent_profiles.rs`, `capabilities_schema.rs`, `plan_schema*`, `scaffold/`, `rag/`, `doclang/`, `docdiff/` | 에이전트 CLI 보조(스키마·스캐폴드·RAG·diff) |
| `atomic_file.rs`, `subsecond_dev.rs` | 파일 원자 쓰기 / 핫패치 개발용(`subsecond-dev` feature) |

참고: wasm 빌드에서는 `cfg(not(wasm32))` 모듈이 컴파일되지 않고, 쓰지 않는 코드는 링커가 제거한다(`Cargo.toml` features 주석). 루트 `crates/` 는 `rhwp-contracts`, `rhwp-ooxml-chart`, `rhwp-password-crypto`.

## 4. Studio 모듈 표 (`rhwp-studio/src/`)

| 폴더 / 파일 | 역할 |
|---|---|
| `main.ts` (2,448줄) | 부트스트랩·모든 배선: wasm 초기화, 레지스트리·디스패처, `window.rhwpStudio`, 플러그인 allowlist(`resolvePlugin` :336), embed 런타임 설치(:2312~), 파일 열기 깔때기 |
| `core/` | `wasm-bridge.ts`(문서 소유·내보내기), 폰트 로딩/대체, 이벤트 버스(`event-bus.ts`), 더티 상태, 사용자 설정, 오류(`command-error.ts`), 문서 서명·열기 세션 |
| `engine/` | 편집 엔진: `input-handler*.ts`(키보드·마우스·IME·표·그림·하이퍼링크), `command.ts`(편집 커맨드 클래스), `history.ts`(undo/redo), `cursor.ts`, 선택·캐럿·표 오버레이 렌더러 |
| `command/` | 커맨드 레지스트리(`registry.ts`)·디스패처(`dispatcher.ts`)·`commands/{file,edit,format,insert,page,table,tool,view,hyperlink}.ts`, 단축키 맵, 저장 형식·대상, 인쇄 |
| `view/` | 캔버스 뷰(`canvas-view.ts`, 풀), CanvasKit 렌더러, 좌표계, 그리드, 머리말/꼬리말 편집 오버레이, 사이드 패널 호스트(`side-panel-host.ts`) |
| `ui/` | 메뉴바·툴바·컨텍스트 메뉴·약 60개 대화상자(글자/문단/표/그림/찾기/스타일/PDF 가져오기 …), 토스트, `chrome-mode.ts`(embed 프로파일) |
| `automation/` | `AutomationHost`(커맨드·메뉴 조작 표면), `menu-dom.ts`, `chrome.ts`(UI 요소 가시성) |
| `plugin/` | 플러그인 계약(`types.ts`)·호스트(`host.ts` PluginHostRegistry/Facade)·선택 텍스트·개발용 `dev-probe-plugin.ts` |
| `embed/` | iframe 임베드 RPC: `protocol.ts`(핸드셰이크·capability), `rpc-router.ts`(메서드 분기), `runtime.ts`(postMessage/MessagePort), `field-events.ts` |
| `document-agent/` | 외부 에이전트용 "문서 상태/선택 컨텍스트/텍스트 커맨드 적용·되돌리기" 계약과 컨트롤러 |
| `ai/` | 내장 AI 도우미(`plugin.ts`, `agent/`, `tools/`, `provider/`, `settings/`, `ui/`) — 아래 5절 및 `AI_TOOLS_FINDINGS.ko.md` |
| `hwpctl/` | 한컴 HwpCtrl 호환 액션 레이어(`@rhwp/hwpctrl` 플러그인이 사용) |
| `compare/` | 문서 비교(diff-engine, 결과 창) |
| `recovery/`, `history/`, `recent/` | 자동저장·복구(암호화 포함), IndexedDB 이력 저장, 최근 문서 |
| `i18n/` | 다국어(`locales/`, `t()`) |
| `styles/`, `style.css` | 스타일 |
| `dev/` | 개발용 프로브(성능·스크롤·줌) — 프로덕션 영향 없음 |
| `vite-env.d.ts` | 빌드 상수 선언(`__RHWP_AI__`, `__RHWP_HWPCTRL__` …) |
| 폴더 밖 | `public/`(정적 자원), `e2e/`(Playwright/CDP 시험, 수백 개), `tests/`(node --test 단위), `types/`, `index.html`(메뉴 구조의 선언, `#side-panel-host` 포함) |

## 5. 바깥에서 조작하는 창구

### 5.1 `window.rhwpStudio` (`main.ts:186` 이하, 프로덕션 빌드에도 항상 노출)
- `notifySaved(fileName?)` — 호스트가 저장 완료를 알림 (`completeHostSave`)
- `links.setHandler` — 링크 클릭 처리를 호스트가 가로챔
- `forms.setActionsEnabled` — 양식 동작 on/off
- `fonts.setProvider / getState` — 호스트가 폰트 제공
- `automation` (:329) — `AutomationHost` 인스턴스
- `plugins` (:397) — `PluginHostRegistry` (`list/load/unload/invoke/isLoaded/unloadAll`)
- 개발 모드 전용(`import.meta.env.DEV`): `__wasm`, `__eventBus`, `__documentState`, `__autosaveManager`, `__theme`, `__localFonts`

### 5.2 `AutomationHost` (`automation/host.ts`, 타입 `automation/types.ts`)
`listCommands()`, `getMenuModel()`, `isEnabled(id)`, `execute(id, params, options)`, `getContext()`, `registerCommand`(`ext:` 접두사 필수), `unregisterCommand`, `addMenuItem`, `removeMenuItem`, `disposeOwned`. 실행은 메뉴·툴바와 같은 `CommandDispatcher` 를 타므로 양식 모드 차단·`canExecute` 게이트가 그대로 적용된다. 문서를 직접 바꾸지는 않는다(문서는 플러그인 transaction).

### 5.3 embed 런타임 RPC (`embed/rpc-router.ts` switch, 핸들러는 `main.ts:2330~2445`)
- 핸드셰이크: `rhwp-connect`(version 1, capabilities 협상) → 이후 MessagePort 로 `rhwp-request/response`. 부모 origin 은 http/https 만 허용(`protocol.ts isUsableParentOrigin`), 첫 연결의 origin 에 바인딩(`runtime.ts:190`). 이벤트 push: `documentChanged`, `fieldChanged`, `commandError`.
- 메서드: `ready`, `loadFile`, `getCommandErrorState`, `pageCount`, `getRendererDiagnostics`, `getFontDecisionTrace`, `getPageSvg`, `exportHwp`, `exportHwpx`, `exportHml`, `getHmlSaveState`, `exportHwpVerify`, `notifySaved`, `getDocumentState`, `getSelectionContext`, `applyTextCommand`, `revertTextCommand`, `focusTarget`, `automation.list`, `automation.menuModel`, `automation.isEnabled`, `automation.execute`, `automation.context`, `plugin.list`, `plugin.load`, `plugin.unload`, `plugin.invoke`, `chrome.get`, `chrome.set`.
- `plugin.invoke` → 핸들러 `pluginInvoke(id, method, args)` → `plugins.invoke` (`main.ts:2444`). 반환은 구조화 복제 가능해야 한다. 부모는 데이터만 보낼 수 있다(함수 인자 불가).
- embed 모드(`?chrome=embed` 계열, `ui/chrome-mode.ts`)에서는 사이드 패널·문서 수명주기 커맨드·드롭 열기가 꺼진다(`main.ts:358, 408, 1118`).

### 5.4 document-agent (`document-agent/`)
`DocumentAgentController`(`controller.ts`)가 `getDocumentState`, `getSelectionContext`, `applyTextCommand`(:416), `revertTextCommand`(:590), `focusTarget` 제공. 명령은 strict schema(`contract.ts`, 필드 정확 일치·SHA-256 다이제스트 검증)로 검증되고 본문 문단 대상 텍스트 교체를 해시로 보증한다. embed RPC 로만 노출(별도 창구).

### 5.5 플러그인 시스템
- 계약: `plugin/types.ts` — `StudioPlugin {id, apiVersion=1, activate(host)→surface, deactivate?}`, `PluginHost`(borrowDocument, transaction, read, loadDocument, createBlankDocument, getCaret, getSelectionText, selectTextRange, automation, ui, events, onDocumentSwap).
- 등록: **allowlist 하드코딩** — `main.ts:336 resolvePlugin(id)`. 프로덕션에서는 임의 URL 로드 경로가 없다. 현재 id: `hwpctrl`(`__RHWP_HWPCTRL__` 분기, `@rhwp/hwpctrl/studio-plugin` 동적 import), `ai-assistant`(`__RHWP_AI__` 분기, `@/ai/plugin`), `dev-probe`(DEV 만). 그 외는 throw → 호스트에 `PLUGIN_NOT_ALLOWED`.
- 로드/호출: `plugins.load(id)`(→ `{id, methods}`), `plugins.invoke(id, method, args[])`(동기 호출, 반환값 그대로; async 면 Promise), `unload`. 자동 로드는 AI 하나뿐: `main.ts:2306` `if (__RHWP_AI__ && sidePanels && window.parent === window) plugins.load('ai-assistant')`.
- 빌드 플래그: `rhwp-studio/vite.config.ts:22-27,37-38`
  - `RHWP_WITHOUT_HWPCTRL=1` → `__RHWP_HWPCTRL__=false`
  - `RHWP_WITHOUT_AI=1` → `__RHWP_AI__=false` (기본은 둘 다 true)
  - (그 외) `RHWP_DISABLE_EXTERNAL_WEBFONTS=1`, `RHWP_SUBSECOND=1`(핫패치 개발)
- 선언: `src/vite-env.d.ts:4-8`.
- 사이드 패널: `view/side-panel-host.ts SidePanelController`, 호스트 DOM `#side-panel-host`(index.html). embed 모드에는 만들지 않는다.

## 6. 빌드

1. **WASM (`pkg/`)**: 루트에서 `scripts/wasm-pack-locked.sh --target web --out-dir pkg` (AGENTS.md/CLAUDE.md 가 이 경로만 허용: studio 안에서 실행 금지). 내부적으로 `wasm-pack`(Dockerfile 은 0.15.0 고정) → `pkg/rhwp.js`, `pkg/rhwp_bg.wasm` 생성, 성공 후 studio public 경로에도 같은 glue 를 맞춰 복사. Docker 빌드도 가능(README 232행). 환경변수 `RHWP_WASM_CDYLIB_ONLY=0|1` 은 실험용(fat LTO). 현재 체크아웃에는 `pkg/` 가 **없다** — 빌드 필요.
2. **Cargo features** (`Cargo.toml:360`): 기본 `console_error_panic_hook, pdf-import, pdf-jbig2, pdf-jpeg2000, pdf-icc, wasm-api`. wasm 크기를 줄이려면 PDF 가져오기 feature 를 끄는 게 가장 큰 후보(단 studio 의 PDF 열기 기능이 사라지고 `wasm.hasPdfImportCapability()` 가 false → "PDF_IMPORT_DISABLED" 오류, `main.ts:1728`). `native-skia*`, `subsecond-dev`, `dev-tools` 는 wasm 에 불필요. 릴리스 프로파일은 `Cargo.toml:591` `lto = true, codegen-units = 1, strip = "debuginfo"`. `wasm-opt` 인자(`[package.metadata.wasm-pack]`)는 확인되지 않음(grep 결과 없음).
3. **Studio**: `rhwp-studio/` 에서 `npm run build` = `tsc && vite build`; 개발 `npm run dev`(vite). `vite.config.ts` alias `@wasm/rhwp.js → ../pkg/rhwp.js`, `@wasm → ../pkg`, `@ → src`(tsconfig paths 도 동일: `@/*`, `@wasm/*`). 번들은 WASM 을 정적 자원으로 싣고 PWA(workbox)가 `.wasm` 을 캐시한다(`vite.config.ts` ~149행 `wasm-cache`). 진입 청크 약 2.2 MB(`chunkSizeWarningLimit: 2500`), CanvasKit(`canvaskit-wasm`)이 별도 wasm 로 추가.
4. **크기 관련**: `RHWP_WITHOUT_AI=1`(AI 청크 + 제공자 SDK `@anthropic-ai/sdk` 제거), `RHWP_WITHOUT_HWPCTRL=1`(`npm/hwpctrl-ocx` 제거). 폰트·자산은 `public/` 와 `assets/`.
5. **시험**: `npm test`(node --test `tests/*.test.ts`), e2e 는 `rhwp-studio/e2e/*.mjs` + `run-with-vite.mjs`(대부분 헤드리스 Chrome/CDP). Rust 는 `cargo test`(`tests/generated/regression_suite_*`).
6. **CI**: 원본 `.github/workflows` 는 `cs/main` 에서 삭제됨. 현재 `.github/` 에는 actions, scripts, codeql 등 비workflow 파일만 남아 있다.

## 7. 다운스트림(우리) 수정 시 주의점

원칙(`cs/README.md`): 우리 파일은 `cs/` 와 `.github/workflows/cs-*.yml` 에만. 원본 수정은 `[cs]` 접두 커밋 + `cs/PATCHES.md` 기록. 원본 갱신은 `cs/scripts/sync-upstream.sh <tag>`.

작은 패치가 들어갈 자리와 충돌 가능성

| 자리 | 용도 | 충돌 가능성 |
|---|---|---|
| `rhwp-studio/src/main.ts:336-352 resolvePlugin` | 내장 플러그인 id 1줄 등록 (예: `cs-agent-tools`) | 중간. 이 함수는 hwpctrl/ai/dev-probe 가 번갈아 추가되는 자리. **함수 맨 끝 `throw` 바로 앞**에 한 줄만 넣고 import 경로를 짧게 유지하면 병합이 쉽다 |
| `rhwp-studio/src/main.ts:2306` (AI 자동 로드 블록) | 우리 플러그인 자동 로드가 필요할 때 | 낮음~중간. 호스트(웹 에이전트)가 `plugin.load` 를 부르게 하면 패치 불필요 |
| `rhwp-studio/vite.config.ts:60-80 server.fs.allow` | 개발 서버에서 저장소 루트의 `cs/` 를 읽게 | 낮음. 프로덕션 빌드엔 불필요(번들러는 상대경로 import 를 그대로 따라감). 개발 서버 사용 시에만 필요 |
| `rhwp-studio/tsconfig.json:22 include:["src"]` | `cs/` 파일 타입 검사 | `tsc` 는 import 된 파일을 따라가므로 대개 불필요하나 `noUnused*` 등 엄격 옵션이 `cs/` 코드에도 적용됨 |
| `src/wasm_api.rs` | WASM API 추가가 필요할 때 | **높음**. 10k 줄 파일이라 upstream 이 거의 매 릴리스 수정. 가능하면 `src/wasm_api/` 아래 새 파일이 아니라 JS 쪽에서 해결 |
| `index.html`, `ui/*`, `i18n/locales` | 문구·브랜딩 | 높음(upstream 이 자주 수정). 새 문구는 `cs/` 의 별도 로케일 병합 대신 최소 변경 |
| `rhwp-studio/src/ai/**` | AI 도구 직접 수정 | 높음 — 건드리지 말고 import 해서 쓰는 쪽(`cs/`)에서 감싼다 |

기타 유의점
- 원본은 AGENTS.md 에 PR/검증 규칙이 매우 엄격하다. `cs/main` 은 이를 따를 필요 없지만, upstream 파일 수정 시 해당 영역의 e2e(`e2e:undo-depth`, `e2e:embed`, `e2e:document-agent`)를 돌려 회귀를 확인하는 것이 안전.
- `pkg/` 는 gitignore 대상이며 Rust 소스가 바뀌지 않는 한 재빌드 불필요(원본 v0.9.1 태그와 같은 wasm 을 쓰면 크기·동작이 upstream 과 동일).
- 도구 모듈 import 경계: AI 도구(`ai/tools/*.ts`)는 `@/plugin/types` 와 `../provider/types.ts`(타입 전용)만 참조 → 분리해서 재사용하기 좋다(자세한 내용은 AI_TOOLS_FINDINGS.ko.md).
- 문서 세대(generation)·lease 규약을 깨는 직접 WASM 접근(`window.__wasm`)은 DEV 전용이다. 프로덕션 자동화는 반드시 플러그인 `transaction/read` 또는 `automation.execute` 를 쓴다.
