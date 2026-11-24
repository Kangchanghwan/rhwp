# cbEdit v1: Clipboard Share ↔ 편집기 iframe 규약

부모: Clipboard Share (https://clipboardapp.org, https://www.clipboardapp.org, Vercel 미리보기 https://*.vercel.app, 개발 http://localhost:*, http://127.0.0.1:*)
자식: 한글 편집기 https://hwp.clipboardapp.org, 오피스 편집기 https://office.clipboardapp.org

## iframe 주소
`<편집기 출처>/?embed=cs&theme=light|dark`
- `embed=cs` 일 때 편집기는: 처음 화면(홈, 최근 파일, 새 문서 목록)을 띄우지 않고 빈 대기 상태로 open 을 기다린다. 자동저장 복구 대화상자·로컬 자동저장 복구 제안을 띄우지 않는다. 로컬 글꼴 감지 같은 첫 실행 대화상자도 띄우지 않는다(대체 글꼴로 진행).
- theme 은 지원하면 따르고, 지원 못 하면 무시한다.

## 메시지 모양 (모두 window.postMessage, 구조화 복제 가능한 값만)
부모 → 자식 요청: `{ cbEdit: 1, id: <string>, method: <string>, args: <object> }`
자식 → 부모 응답: `{ cbEdit: 1, id, ok: true, result }` 또는 `{ cbEdit: 1, id, ok: false, error: { code, message } }`
자식 → 부모 이벤트: `{ cbEdit: 1, event: <string>, ...data }`

보안:
- 자식은 `event.origin` 이 위 부모 허용 목록(frame-ancestors 와 같은 목록)에 맞을 때만 요청을 받는다. `event.source === window.parent` 도 확인한다.
- 자식이 부모로 보낼 때 targetOrigin 은 처음 받은 유효 요청의 origin 을 쓴다. 그 전(ready 이벤트)에는 `location.ancestorOrigins[0]`(있고 허용 목록에 맞으면) 또는 `document.referrer` 의 origin(허용 목록에 맞으면)을 쓰고, 둘 다 없으면 ready 를 '*' 로 보낸다(ready 에는 비밀이 없다).
- 부모는 `event.origin === 편집기 출처 && event.source === iframe.contentWindow` 일 때만 받는다.
- 바이트(ArrayBuffer)는 transfer 목록으로 넘긴다.

## 이벤트 (자식 → 부모)
- `ready`: `{ cbEdit:1, event:'ready', editor:'hwp'|'office', version:<string>, accepts:[확장자...], chrome:{ bg, fg, border } }`
  편집기가 open 을 받을 수 있게 된 뒤 한 번 보낸다. chrome 은 편집기 맨 위 메뉴줄의 배경·글자·아래 테두리 색(CSS 색 문자열). 부모는 이 색으로 32px 상단 바를 칠해 편집기와 이음새가 없게 한다.
- `chrome`: `{ event:'chrome', chrome:{bg,fg,border} }` 편집기 테마가 바뀌면.
- `dirty`: `{ event:'dirty', dirty:true|false }` 변경 여부가 바뀔 때마다(같은 값 반복 금지).
- `saveRequest`: `{ event:'saveRequest' }` 사용자가 편집기 안에서 Ctrl/Cmd+S 또는 편집기 자체 저장 메뉴를 눌렀을 때. 편집기는 이때 자기 내려받기를 하지 않는다. 부모가 자기 저장 메뉴를 연다.
- `error`: `{ event:'error', code, message }` 열린 뒤 복구 불가 오류(엔진 정지 등).

## 메서드 (부모 → 자식)
- `open({ name, bytes: ArrayBuffer })` → `{ pages?: number }`
  문서를 열고 화면에 그려져 편집 가능해지면 응답. 열려 있던 문서는 묻지 않고 바꾼다. dirty 는 false 로 시작.
  실패 code: `UNSUPPORTED`(확장자), `OPEN_FAILED`, `BUSY`.
- `export({ format?: string })` → `{ bytes: ArrayBuffer, ext: string, mime: string }`
  format 생략 = "원래 형식으로". 실제로 쓴 확장자를 ext 로 돌려준다.
  - 한글: hwp→hwp, hwpx→hwpx. format 'hwp' | 'hwpx' 로 지정 가능.
  - 오피스: docx→docx, xlsx→xlsx, pptx→pptx, xls→xls, pdf→pdf. doc→docx, ppt→pptx (오픈소스 변환기에 doc/ppt 쓰기가 없음). format 으로 다른 형식 지정은 이번 범위 밖(필요하면 UNSUPPORTED).
  export 는 dirty 를 바꾸지 않는다.
  실패 code: `NO_DOCUMENT`, `EXPORT_FAILED`, `UNSUPPORTED`.
- `markSaved()` → `{}` dirty 를 false 로(부모가 방에 올린 뒤 부른다). dirty 이벤트를 보낸다.
- `state()` → `{ loaded: bool, dirty: bool, name: string|null, ext: string|null }`
- `setTheme({ theme: 'light'|'dark' })` → `{}` 지원 안 하면 그냥 `{}`.

알 수 없는 method → `{ ok:false, error:{ code:'UNKNOWN_METHOD' } }`. 처리 중 예외 → code `INTERNAL`.

## 시간 기준 (부모 쪽)
- iframe load 후 ready 까지 최대 120초 (오피스 첫 방문은 약 25~33MB 내려받기).
- open 최대 120초, export 최대 60초, 그 밖 10초.
