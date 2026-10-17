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

태그의 버전과 `package.json` 버전 맞추고 `dev`에서 `v1.2.3-beta.4` 같은 태그 푸시
