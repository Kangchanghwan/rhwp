#!/usr/bin/env bash
# 원본 릴리스 태그를 cs/main 위에 병합한다. 사용: cs/scripts/sync-upstream.sh <tag>
set -euo pipefail
tag="${1:?원본 태그를 지정하세요 (예: v0.9.2)}"
git remote get-url upstream >/dev/null 2>&1 || git remote add upstream https://github.com/edwardkim/rhwp.git
git fetch upstream "refs/tags/${tag}:refs/tags/${tag}" --filter=blob:none
git switch -c "cs/sync/${tag}" cs/main
set +e
git merge --no-ff --no-commit "${tag}"
set -e
# 원본 workflow 와 dependabot 은 포크에서 쓰지 않는다 (새로 생긴 것 포함)
for f in $(git ls-files .github/workflows | grep -v '^.github/workflows/cs-') .github/dependabot.yml; do
  git rm -q --cached --ignore-unmatch "$f" >/dev/null; rm -f "$f"
done
commit=$(git rev-parse "${tag}^{commit}")
python3 - "$tag" "$commit" <<'PY'
import json, sys
p = 'cs/upstream.json'; d = json.load(open(p)); d['tag'], d['commit'] = sys.argv[1], sys.argv[2]
open(p, 'w').write(json.dumps(d, indent=2, ensure_ascii=False) + '\n')
PY
git add cs/upstream.json
echo "--- 충돌 파일 (없으면 비어 있음)"
git diff --name-only --diff-filter=U
echo "충돌을 해결한 뒤: git commit -m \"원본 ${tag} 병합\" && git push -u origin cs/sync/${tag}"
