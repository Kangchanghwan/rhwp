# 원본 파일 수정 목록

원본(edwardkim/rhwp) 파일을 고친 커밋을 여기에 적습니다. 원본을 받아 올 때 이 목록을 기준으로 충돌을 확인합니다.

| 파일 | 내용 | 이유 | 커밋 |
|---|---|---|---|
| `.github/workflows/*` (삭제) | 원본 workflow 25개 제거 | 포크에서 원본 CI·Pages 배포·예약 작업이 돌지 않게 | cs/main 첫 커밋 |
| `.github/dependabot.yml` (삭제) | 의존성 자동 PR 제거 | 원본이 관리 | cs/main 첫 커밋 |
| `rhwp-studio/src/main.ts` | `resolvePlugin()` 에 `cs-agent-tools` 동적 import 1줄 (`__RHWP_AI__` 분기 밖) | 내장 플러그인 로드 길을 연다. AI 패널을 뺀 빌드에서도 도구가 남게 | cs/agent-tools |
| `rhwp-studio/src/main.ts` | 상단 import 1줄 + `rhwpStudio.plugins` 대입 뒤 `installCsAgentToolsGlobal(...)` 1줄 | `window.rhwpStudio.csAgentTools` 게으른 전역(처음 호출 때 플러그인 로드) | cs/agent-tools |
| `rhwp-studio/src/main.ts` | `PluginHostRegistry` 의 `loadDocument` 가 `{ suppressDialogs: true }` 를 넘김 (1줄) | 플러그인 경유 문서 열기가 「로컬 글꼴 감지」 모달에서 영원히 멈추는 것을 막는다(hwpctrl 플러그인 로드에도 같은 효과) | cs/agent-tools |
