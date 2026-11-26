# 릴리즈

## 정식 버전

1. `dev`에서 `main`으로 머지
2. Actions → Release → Run workflow
3. `v` 접두사 없이 `main` 에서 버전 숫자 입력
4. release 수행됨
5. 릴리즈 성공 후 액션이 `main → dev`를 자동 병합, 충돌이 나면 `main → dev` PR을 생성하거나 기존 PR을 재사용

버전은 현재 버전보다 높아야 함.

자동 동기화에는 `dev` 쓰기 권한과 `pull-requests: write` 권한도 필요.  
저장소의 **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests** 에서 활성화 가능.

검증 도중 다른 커밋이 `main`에 올라오면 커밋·태그 푸시가 함께 거절되고 최신 `main`에서 새 실행을 시작.

태그 푸시 후 업로드에 실패하면 **기존 실패한 실행에서 Re-run failed jobs**를 사용.

## 베타 버전

1. Actions → Release → Run workflow
2. 브랜치를 **`dev`**로 선택하고 `v` 접두사 없이 목표 버전 입력 (예: `4.2.0` → 기존 태그를 확인해 `4.2.0-beta.1`, `4.2.0-beta.2`… 자동 부여 / `4.2.0-beta.1` 직접 입력도 가능)
3. 검증 통과 후 액션이 `package.json`·`package-lock.json`을 커밋하고 `v4.2.0-beta.N` 태그 푸시 + **Pre-release**로 게시 (`main`과 `latest` 릴리즈는 변경하지 않음)

*(수동으로 태그를 푸시할 때도 `dev` 전용 커밋에는 `-beta.N` 같은 프리릴리스 접미사가 있는 태그만 허용되며, 정식 태그는 `main`에 포함된 커밋에서만 통과합니다.)*
