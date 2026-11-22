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
