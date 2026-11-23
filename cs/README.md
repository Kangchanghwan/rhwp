# cs/ — Clipboard Share 다운스트림 작업 폴더

이 레포는 [edwardkim/rhwp](https://github.com/edwardkim/rhwp)(MIT)의 포크입니다.
원본 저작권과 라이선스는 루트의 `LICENSE`, `THIRD_PARTY_LICENSES.md` 를 그대로 따릅니다.
이 포크는 HWP/HWPX 편집기를 `https://hwp.clipboardapp.org` 에 배포하고,
웹 에이전트가 함수 호출로 문서를 고칠 수 있게 하는 작업을 담습니다.

## 브랜치

| 브랜치 | 용도 |
|---|---|
| `main` | 원본 `main` 그대로. 직접 커밋하지 않습니다 (원본은 릴리스 때만 `main` 을 갱신합니다). |
| `cs/main` | 기본 브랜치. 원본 릴리스 태그 위에 우리 변경을 쌓습니다. 여기에 올라가면 운영 배포됩니다. |
| `cs/*` | 작업 브랜치. 미리보기 주소로만 배포됩니다. |

## 원칙

- 우리 파일은 `cs/` 와 `.github/workflows/cs-*.yml` 에만 둡니다.
- 원본 파일을 고쳐야 하면 커밋 제목을 `[cs]` 로 시작하고 `cs/PATCHES.md` 에 적습니다.
- 원본 workflow 는 `cs/main` 에서 지웁니다(포크에서 원본 CI·배포가 돌지 않게). 원본을 받아 올 때
  `cs/scripts/sync-upstream.sh` 가 새로 들어온 원본 workflow 도 다시 지웁니다.
- 현재 기준 원본: `upstream.json` 참고.

## 원본 릴리스 받아 오기

```sh
cs/scripts/sync-upstream.sh v0.9.2   # 태그를 지정
```
스크립트가 `cs/sync/<tag>` 브랜치에 병합하고 충돌 목록을 보여 줍니다. 검사(미리보기 배포)를 통과하면 PR 로 `cs/main` 에 넣습니다.

## 빌드와 배포 (`.github/workflows/cs-deploy.yml`)

`cs/*` 브랜치에 push 하면 이 레포의 소스로 사이트를 만들어 Cloudflare Pages(`hwp-editor` 프로젝트)에 올립니다.

| 브랜치 | 배포 |
|---|---|
| `cs/main` | `--branch main` (운영, hwp.clipboardapp.org) |
| 그 밖의 `cs/*` | `--branch <브랜치 이름의 / 를 - 로 바꾼 것>` (미리보기만, 예: `cs/foo` -> `cs-foo.hwp-editor-aai.pages.dev`) |

순서:

1. **체크아웃**: `blob:none` 부분 복제, 깊이 1, 스파스(`/mydocs/`, `/pdf/`, `/samples/`, `/tests/` 의 큰 부분, `tools/llm_verifier` 의 fixtures 등 제외). 로그에 크기를 찍습니다. 빌드가 빠진 파일 때문에 깨지면 workflow 의 `sparse-checkout` 목록에 다시 넣습니다.
2. **엔진 WASM**: Rust 입력(Cargo.toml, Cargo.lock, build.rs, rust-toolchain.toml, src, crates, vendor, 글꼴·글꼴 규칙, data, saved, 빌드 스크립트)의 해시를 키로 `pkg/` 를 캐시합니다. 적중하면 Rust 빌드를 통째로 건너뛰고, 아니면 원본과 같은 방법(`scripts/measure_render_diff_wasm.py --profile release --build-mode standard`, Rust 1.93.1, wasm-pack 0.15.0)으로 빌드하고 `scripts/verify_release_wasm.py` 로 소스·프로필·wasm-opt·산출물 해시를 확인합니다. cargo registry/target 도 따로 캐시합니다.
   원본의 무거운 검증(`verify-release-wasm`: render diff, 네이티브 skia 빌드)은 수동 실행(`workflow_dispatch`, `full_verify` 체크)에서만 돌립니다.
3. **사이트 조립** (`cs/build/build.mjs`): 이 레포의 `rhwp-studio` 를 `npm ci` + `vite build --base=/` 로 빌드하고(AI 도우미 제외, 외부 웹폰트 끔), 엔진 wasm 을 2조각으로 나눠(파일당 25 MiB 제한) glue 로더를 패치하고, Cafe24·Happiness Sans 글꼴을 Pretendard 로 바꾸고 파일과 라이선스 PDF 를 뺍니다. PWA service worker/manifest 제거, `cs/agent` 번들(`cbHwpAgent` postMessage 창구) 삽입, `manifest.json`, `404.html`, `_headers`, `build-identity.json` 을 씁니다.
   `build-identity.json` 에는 `source: "fork"`, 포크 커밋, `cs/upstream.json` 의 원본 태그와 커밋, 엔진 wasm sha256, npm `@rhwp/core` 와 같은지(`core.wasmSameAsNpm`)가 들어갑니다.
4. **검사**: `cs/agent` 단위 테스트, Pages 제한(파일 2만 개 미만, 파일당 25 MiB 이하), Playwright 게이트(`cs/gate`: 빈 문서와 저장소 샘플 hwp/hwpx 를 열고 고치고 내보내고 다시 열어 비교, agent 창구, 글꼴 매핑, 외부 요청 없음, CSP). 하나라도 실패하면 배포하지 않습니다.
5. **배포**: `npx wrangler pages deploy cs/out --project-name hwp-editor --branch <위 표>`. 배포 뒤 `build-identity.json` 의 커밋이 맞는지 확인합니다.

필요한 시크릿: `CLOUDFLARE_API_TOKEN`(Pages 쓰기), `CLOUDFLARE_ACCOUNT_ID`.

로컬에서 `cs/agent`·`cs/studio` 순수 로직만 고칠 때: `cd cs && npm ci && npm test`. Rust/WASM 빌드는 로컬에 도구가 없으면 Actions 에서만 합니다.
## 에이전트 도구 플러그인 (`cs-agent-tools`, 3단계)

AI 채팅 패널 없이 문서 도구(읽기 8·쓰기 29·명령 3 = 40개, `create_document` 제외 + 새 도구 5개 = 45개)를 직접 호출한다. 코드는 `cs/studio/`, 설계는 `cs/docs/AI_TOOLS_FINDINGS.ko.md`.

**API v2 (`window.hwpAgent`, 서버 없음)** — 어떤 브라우저 에이전트든 같은 페이지에서 `await hwpAgent.help()` 로 사용 설명서를 읽고 시작한다. 시작 때 `<meta name="ai-agent-api">` 를 넣고, WebMCP(`document.modelContext.registerTool`)가 있으면 도구를 등록한다. 새 도구: `list_tables`, `read_table`, `set_cells`(검증 후 한 번에, 병합에 덮인 칸은 `COVERED_BY_MERGE`), `fill_fields`(`notFound`/`ambiguous` 보고), `run_plan`(사전 검증 + 전부 아니면 전무 + undo 1번). `callTool(name, args, {dryRun:true})` 는 문서를 바꾸지 않고 바뀔 내용만 보고하며, `replace_text`/`set_cell_text`/`set_cells`/`fill_fields` 결과에는 다시 읽어 확인한 `verified` 가 붙는다. `find`/`after` 는 정확히 못 찾을 때만 공백 종류·개수를 무시해 다시 찾고(`normalizedMatch`, `matchedText`), 메뉴 바 오른쪽 「AI에게 맡기기」 버튼이 에이전트용 안내문(`hwpAgent.agentPrompt`)을 복사한다. 전체 설명: [docs/AGENT_API.ko.md](docs/AGENT_API.ko.md).

**호출 (같은 페이지)** — 처음 부를 때 플러그인을 올린다(시작 때 자동 로드 없음). `window.hwpAgent` 는 아래 `csAgentTools` 와 같은 객체다:
```js
const t = window.rhwpStudio.csAgentTools;   // = window.hwpAgent
await t.help();                                        // 사용 설명서 문자열
await t.listTools();                                   // [{name, group, description, inputSchema, headless, requires?}]
await t.callTool('replace_text', { find, replace });   // {ok:true,result} | {ok:false,error:{code,message}}
await t.callTool('insert_picture', args, { picture: { dataBase64 } });   // headless:false 도구는 options 필요
await t.undo(); await t.redo();
await t.exportDocument('hwpx');                        // {ok, result:{format, bytes:Uint8Array}}
await t.loadDocument(bytes, 'a.hwpx');                 // 로컬 글꼴 모달 없이 연다
```
**호출 (iframe 부모)** — embed RPC: `pluginLoad('cs-agent-tools')` 후 `pluginInvoke('cs-agent-tools', 'callTool', [name, args])` (`listTools`, `undo`, `redo`, `exportDocument`, `loadDocument` 도 같은 방식).

쓰기는 자동 적용이고 호출 1회 = undo 1스텝. 오류 코드: `TARGET_NOT_FOUND`(없는 글을 찾음 → 변경 안 됨), `AMBIGUOUS_TARGET`, `INVALID_INPUT`, `UNKNOWN_TOOL`, `FILE_REQUIRED`, `DOCUMENT_RELEASED`, `APPLY_FAILED`, `REFUSED`, 그리고 v2: `COVERED_BY_MERGE`, `OUT_OF_RANGE`, `TABLE_NOT_FOUND`, `MULTI_PARAGRAPH_CELL`, `PLAN_INVALID`, `PLAN_FAILED`, `STEP_NOT_ALLOWED`, `DRYRUN_UNSUPPORTED`.
`headless:false`: `insert_picture`(그림 바이트 필요), `select_text`·`run_command`·`get_selection`(편집기 선택·화면 필요).
읽기 결과는 문서 본문이라 비신뢰 데이터다(프롬프트 주입 주의). 호출은 내부에서 직렬화된다.

### 빌드 요구사항: `RHWP_WITHOUT_AI=1`

운영 빌드는 `RHWP_WITHOUT_AI=1` 로 만든다(`RHWP_WITHOUT_AI=1 tsc && RHWP_WITHOUT_AI=1 vite build`). 이유: AI 채팅 패널·설정·제공자 SDK·「도구」 메뉴 항목이 빠진다. 우리 플러그인이 `ai/tools/*` 를 직접 import 하므로 도구 코드는 `__RHWP_AI__` 와 무관하게 `agent-tools-plugin` 청크에 남는다(실측: 이 빌드에 `anthropic`·`ai-assistant` 문자열 없음, 도구는 있음).

### 검사

`node cs/gate/agent-tools.e2e.mjs` — `RHWP_WITHOUT_AI=1` 로 빌드해(또는 `--dist <dir>`) 헤드리스 Chromium 에서 .hwpx·.hwp 각각 단계(기본 8 + 새 API 시나리오 9a~9g, 공백 10, 버튼 11)를 돌리고 `cs/gate/agent-tools.report.json`(gitignore)에 쓴다. 필요: `pkg/`(= `@rhwp/core` 0.9.1 npm 파일, 커밋 금지), `playwright`(없으면 `PLAYWRIGHT_DIR=<node_modules 가 있는 폴더>`).
