# 노트링크 (NoteLink)

> 수기 대신 스마트하게, AI와 함께 배우는 노트 앱

공부 시간 **기록** → 필기·녹음 **AI 가공** → 퀴즈·플래시카드 **복습**이 한 앱에서 이어지도록 만드는 학습 앱입니다.
필기 사진, PDF, 강의 녹음을 올리면 AI가 요약·퀴즈·아바타 설명으로 바꿔 줍니다.

> **현재 상태**: 초기 세팅까지 끝난 단계입니다. 세 앱 모두 lint · typecheck · test가 돌아가는 최소 뼈대(앱 하단 탭 5개 빈 화면, `GET /api/v1/health`, `GET /internal/v1/health`)만 있고 기능 코드는 아직 없습니다.
> `infra/docker-compose.yml`(로컬 MongoDB · Azurite)은 아직 없어 아래 `docker compose` 명령은 나중에 사용할 수 있습니다.

---

## 1. 기술 스택

| 영역 | 사용 기술 | 버전 |
| --- | --- | --- |
| 모바일 앱 | Expo (React Native) + TypeScript | Expo SDK 57 · RN 0.86.3 · TS 6.0.3 |
| 메인 서버 | NestJS (Node.js) | NestJS 12 · Node 24 |
| AI 서버 | FastAPI (Python) | FastAPI 0.142 · Python 3.13 |
| 데이터베이스 | MongoDB Atlas (Azure 코리아 중부) | MongoDB 8.0 |
| 파일 저장소 | Azure Blob Storage | — |
| 배포 | Azure App Service (Linux) | — |
| 실시간 | Socket.IO (NestJS 서버에 직접) | 4.8 |
| 캠 · 음성 스터디 | LiveKit Cloud | — |

### AI 서비스

| 기능 | 서비스 |
| --- | --- |
| 요약 · 퀴즈 · AI 설명 | Claude Opus 5.5 |
| 필기 사진 · PDF 읽기 | Claude (이미지 · PDF 직접 입력) |
| 필기 인식 보조 (테스트 후 결정) | Azure AI Document Intelligence |
| 음성 인식 | Azure AI Speech (단어별 시간 정보) |
| 음성 합성 · 아바타 입 모양 | Azure AI Speech (TTS + viseme) |

---

## 2. 구조

```
모바일 앱 ──REST · Socket.IO──▶ NestJS 서버 ──▶ MongoDB Atlas
   │                              │  ▲
   │                              ▼  │ (ai_jobs만)
   │                           FastAPI ──▶ Claude · Azure Speech
   ├── 사진·녹음·PDF 직접 업로드 ──▶ Azure Blob Storage
   └── 캠·음성 ─────────────────▶ LiveKit Cloud (입장 토큰은 NestJS가 발급)
```

- 앱은 **NestJS 서버만** 호출합니다.
- DB는 **NestJS가 관리**하고, FastAPI는 `ai_jobs` 컬렉션만 씁니다.
- 오래 걸리는 AI 작업은 `ai_jobs`에 넣고 처리하며, 진행률은 Socket.IO로 앱에 보냅니다.
- 파일은 앱이 **Blob에 직접** 올리고, DB에는 파일 주소만 저장합니다.
- 캠 영상·음성은 우리 서버를 거치지 않고 **LiveKit으로 직접** 갑니다.

---

## 3. 폴더 구조

```
NoteLink/
├─ apps/
│  ├─ mobile/                 # Expo (React Native) 앱
│  │  ├─ app/                 #   expo-router 화면: (auth) · (tabs) · shop
│  │  ├─ src/
│  │  │  ├─ features/         #   auth, session, content, quiz, social, reward, calendar, progress
│  │  │  ├─ components/  hooks/  stores/
│  │  │  ├─ lib/              #   api, upload(Blob 업로드), socket
│  │  │  ├─ theme/            #   색·글꼴·간격 토큰 (Noto Sans KR)
│  │  │  └─ i18n/             #   한·영·일·중
│  │  └─ assets/
│  ├─ api/                    # NestJS 서버
│  │  ├─ src/
│  │  │  ├─ config/  common/  migrations/
│  │  │  ├─ modules/          #   auth, session, content, ai, quiz, social, studyroom,
│  │  │  │                    #   reward, calendar, progress, notification, upload
│  │  │  ├─ realtime/         #   Socket.IO 게이트웨이 (채팅 · 스터디룸 · AI 진행률)
│  │  │  ├─ ai-jobs/          #   ai_jobs 등록 · 변화 감지 · 결과 반영
│  │  │  └─ clients/          #   FastAPI 호출, Blob 클라이언트
│  │  └─ test/
│  └─ ai/                     # FastAPI AI 서버
│     ├─ app/
│     │  ├─ core/  api/v1/  worker/  services/  clients/  schemas/
│     └─ tests/
├─ packages/
│  └─ shared/                 # 모바일·Node 공용: zod 스키마, 상수, 열거값, 타입
├─ infra/                     # 로컬 개발용 docker-compose (MongoDB, Azurite)
├─ docs/                      # 규칙 · 구조 · API 문서
└─ .github/workflows/         # CI(lint · typecheck · test), 배포
```

---

## 4. 시작하기

### 필요한 것

Git, Node 24, Python 3.13, Docker Desktop, Android 앱 빌드용 JDK 17 + Android Studio.
Mac에서 iOS를 빌드하려면 Xcode 26.4 이상이 추가로 필요합니다.

### Windows

PowerShell을 **관리자 권한**으로 열고 진행합니다.

```powershell
winget install Git.Git
winget install CoreyButler.NVMforWindows
winget install Python.Python.3.13
wsl --install                      # 이후 컴퓨터를 다시 시작
winget install Docker.DockerDesktop
winget install Microsoft.OpenJDK.17
winget install Google.AndroidStudio

nvm install 24
nvm use 24
```

Docker Desktop과 Android Studio를 한 번씩 실행해 둡니다(Android SDK가 설치됨). 그다음 환경 변수를 등록합니다.

```powershell
[Environment]::SetEnvironmentVariable("ANDROID_HOME", "$env:LOCALAPPDATA\Android\Sdk", "User")
[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path", "User") + ";$env:LOCALAPPDATA\Android\Sdk\platform-tools", "User")
```

- Android 앱: `cd apps\mobile` → `npx expo run:android`
- iOS 앱: Windows에서는 직접 빌드할 수 없어 EAS 클라우드 빌드(`npx eas-cli build --profile development --platform ios`)를 씁니다. Apple 개발자 계정이 필요합니다.

### Mac

```bash
brew install git fnm python@3.13
brew install --cask docker-desktop zulu@17 android-studio

fnm install 24
fnm use 24
```

- Xcode 26.4 이상을 App Store에서 설치하고, **Settings > Locations**에서 Command Line Tools를 선택한 뒤 iOS 시뮬레이터를 받습니다.
- `~/.zshrc`에 아래를 추가하고 `source ~/.zshrc`를 실행합니다.

```bash
eval "$(fnm env --use-on-cd --shell zsh)"
export JAVA_HOME=/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools
```

- iOS 시뮬레이터: `cd apps/mobile` → `npx expo run:ios`
- Android 앱: `cd apps/mobile` → `npx expo run:android`

### 프로젝트 실행 (저장소 세팅 완료 후)

```bash
git clone <저장소 주소>
cd NoteLink
npm install
docker compose -f infra/docker-compose.yml up -d
```

AI 서버용 가상환경 (Windows는 `py -3.13`, `apps\ai\.venv\Scripts\pip`)

```bash
python3.13 -m venv apps/ai/.venv
apps/ai/.venv/bin/pip install -r apps/ai/requirements-dev.lock
```

AI 서버 패키지를 더하거나 버전을 바꿀 때는 `apps/ai/requirements.txt`(운영) · `requirements-dev.txt`(개발)를 고친 뒤 `bash apps/ai/lock.sh`로 lock 파일(`requirements.lock` · `requirements-dev.lock`, 간접 의존성까지 고정)을 다시 만들어 함께 커밋합니다. 이 명령에는 `uv`(`pip install uv==0.13.6`)가 필요합니다. 배포 환경은 `requirements.lock`으로 설치합니다.

터미널 3개에서 각각 실행합니다.

```bash
npm run dev:api      # NestJS 서버
npm run dev:ai       # FastAPI 서버
npm run dev:mobile   # 앱 개발 서버
```

> Expo SDK 57에서는 Watchman이 필요 없습니다. iPhone 실기기에 설치하려면 Apple 개발자 계정이 필요합니다.

---

## 5. 개발 규칙

### 이름

- 변수·함수 `camelCase`, 타입·컴포넌트 `PascalCase`, 상수 `UPPER_SNAKE`
- 파일 `kebab-case` (컴포넌트 파일만 `PascalCase`), Python은 `snake_case`
- DB 컬렉션 `snake_case` 복수형 (`study_sessions`), 필드 `camelCase`

### API

- 주소 `/api/v1/study-sessions` 형태, 응답 `{ data }`, 오류 `{ code, message }`
- 시간은 UTC로 저장하고, "오늘"은 서울 기준으로 계산합니다. 하루는 **자정**에 바뀝니다 (`DAY_RESET_HOUR = 0`).

### Git

- 브랜치: `main` ← `develop` ← `feature/FR-번호-설명`
- **디자인 개편 통합 브랜치**: 모바일 디자인 개편(#140)은 화면이 반쯤 바뀐 상태로 `develop`에 섞이지 않도록 단계 PR을 `design/redesign`에 모은 뒤, 다 모이면 `develop`으로 PR 하나로 합칩니다. 이 브랜치에는 승인 · CI 병합 조건이 없고, `develop`을 주기적으로 합쳐 따라갑니다. 단계 PR의 `Closes`는 이슈를 닫지 않으니 최종 `develop` PR에서 닫습니다.
- **기능 하나당 브랜치 하나**: 최신 `origin/develop`에서 기능 브랜치를 만들고 구현 · 테스트 · 리뷰 수정까지 같은 브랜치에서 진행한 뒤 `develop`으로 PR을 보냅니다. 기능 브랜치에서 다른 기능 브랜치를 파생하거나, 미병합 기능 브랜치를 가져와 작업을 쌓지 않습니다.
- **독립 병합**: 기능 PR은 다른 미병합 PR 없이 최신 `develop`에 단독으로 합쳐도 빌드 · 테스트가 통과해야 합니다. 다른 기능의 구현 파일을 직접 가져오는 대신 공용 계약과 화면 경로로 연결하고, 아직 등록되지 않은 화면은 준비 중으로 안내합니다. 공통 기반을 여러 PR에 포함해야 하는 이행 기간에는 해당 파일 내용을 동일하게 유지합니다.
- **작업 시작 전**: 현재 브랜치 · 미커밋 변경 · 최신 `origin/develop` 대비 커밋을 확인합니다. 미커밋 작업을 보존하고, 이전 기능의 미병합 커밋이 섞인 브랜치를 새 기능의 출발점으로 쓰지 않습니다.
- **병합 전 확인**: 각 PR 단독 검사와 함께 겹치는 공통 파일이 같은지, PR 쌍별로 충돌 없이 합쳐지는지 확인합니다. 병합 순서를 맞추는 것으로 누락 파일이나 충돌을 숨기지 않습니다.
- **기능 PR 병합**: `develop`으로 가는 PR은 **Squash and merge**로 병합해 기능 하나를 커밋 하나로 남깁니다. 제목은 기능과 연결 이슈를 설명하고, 상세 커밋 · 리뷰 · 검증 기록은 PR에 보존합니다. `develop`의 선형 이력 규칙과 기존 승인 · CI 규칙을 함께 따릅니다. 이미 공유한 과거 이력은 다시 쓰지 않습니다.

- 커밋: `feat(quiz): 퀴즈 결과 화면 추가 (FR-58)`
- 작업은 이슈부터 만듭니다(양식: 기능 · 개선 / 버그). PR 본문은 템플릿(`.github/pull_request_template.md`)을 채우고 `Closes #이슈`로 연결합니다. `develop`으로 가는 PR은 이슈가 자동으로 닫히지 않으니 병합 후 직접 닫습니다.
- `develop` · `main`에는 직접 push하지 않고 PR로 병합합니다(저장소 관리자 외에는 막혀 있음). 강제 push와 브랜치 삭제는 누구도 할 수 없습니다.
- PR은 리뷰 1명 + 린트·테스트 통과 후 병합합니다.
  - **CI**: `develop` · `main` · `design/redesign`으로 가는 PR과 `develop` · `main`에 들어온 커밋마다 `.github/workflows/ci.yml`이 lint · typecheck · build · test(Dockerfile · compose 파일이 있으면 hadolint · `docker compose config`도)를 돌립니다. `CI 결과`가 통과해야 병합할 수 있습니다. 기능 브랜치에 push만 해서는 CI가 돌지 않으니, 확인이 필요하면 PR(초안 PR도 됨)을 엽니다.
  - **라벨**: 바뀐 경로를 보고 영역 라벨(프론트 · 백엔드 · AI서버 · 인프라 · 공용 · CI·설정 · 문서)이 자동으로 붙습니다(`.github/labeler.yml`). 작업 종류 라벨(`enhancement` / `bug`)은 직접 붙입니다.
  - **승인**: `develop` · `main` 병합에는 최완우(`Choiwanwoo-03`) 또는 최한결(`cchangyeol`) 중 최소 한 명의 Approve가 필요합니다(`.github/CODEOWNERS`). 새 커밋을 올리면 이전 승인은 사라지니 다시 받아야 합니다.
  - **자동 병합**: PR에서 "Enable auto-merge"를 켜 두면 승인과 `CI 결과` 통과가 모두 되는 순간 병합됩니다. 병합된 브랜치는 자동으로 지워집니다.
  - **Codex 리뷰**: `develop` · `main` · `design/redesign`으로 가는 PR이 열리면 리뷰 전용 컴퓨터(self-hosted runner, 라벨 `codex`)가 `scripts/codex-review.sh`로 Codex 리뷰를 돌려 PR 댓글(치명적 문제 · 중요 · 제안 · 좋았던 점 · 권장 조치)로 남깁니다(`.github/workflows/codex-review.yml`). CI가 실패한 상태면 리뷰 대신 실패 로그를 남기고, 고친 커밋이 올라오면 첫 리뷰를 합니다. Codex 사용량을 아끼려고 **자동으로는 첫 리뷰만** 합니다. 지적을 고친 뒤 재리뷰(이전 지적 반영 여부를 먼저 확인)를 받으려면 PR에 `codex-review` 라벨을 붙이거나(바로 떼어지므로 다음에 다시 붙이면 됨), 첫 줄이 `/codex review`인 댓글을 남기거나(다음 줄부터는 설명을 써도 됨), Actions 탭의 "Codex 리뷰 → Run workflow"에서 브랜치는 `main` 그대로 두고 PR 번호를 넣습니다(모두 저장소 쓰기 권한이 있는 사람만, 댓글 요청은 리뷰를 시작하면 👀 · 건너뛰면 😕가 달림). 리뷰하는 동안 새 커밋이 올라오면 리뷰 컴퓨터가 새 커밋으로 다시 요청합니다. 문서(`*.md` · `*.mdx` · `LICENSE` · 루트 `docs/`의 그림 · PDF, 리뷰 기준인 루트 `README.md` · `AGENTS.md` · `CLAUDE.md` 제외)만 바뀐 PR은 자동 리뷰를 건너뛰고, 필요하면 같은 방법으로 요청합니다. 건너뛴 이유는 PR 댓글 없이 Actions 실행 화면에만 남습니다. 첫 리뷰 뒤의 push는 CI 결과를 기다리지 않으므로 CI 실패 안내를 새로 달지 않습니다(해결되지 않은 실패 안내가 있으면 CI를 확인해, 통과했으면 해결 표시를 합니다). 초안 PR은 "Ready for review"로 바꿀 때 리뷰합니다. 리뷰 컴퓨터가 꺼져 있으면 최완우가 `scripts/codex-review.sh <PR번호>`로 직접 돌립니다(재리뷰는 같은 계정의 지난 리뷰를 찾아 이어 가므로, 리뷰 컴퓨터와 같은 계정으로 돌려야 합니다). 리뷰 기준은 `AGENTS.md`의 Code Review Rules입니다.
    - 실패 안내에는 검사한 커밋과 CI 실행 링크를 표시합니다. 같은 커밋의 실패 알림은 기존 댓글을 갱신하고, 최신 CI가 성공하면 리뷰 계정의 과거 실패 댓글을 해결 표시하며 원문 로그는 접어서 보존합니다. 게시 전에 PR 커밋이 바뀌었으면 낡은 결과를 올리지 않습니다. CI 통과와 코드 리뷰의 치명적·중요 지적 해소는 별도로 확인합니다.
  - 리뷰 컴퓨터는 Codex 리뷰 전용입니다. 다른 워크플로에서 `runs-on`에 `self-hosted` · `codex`를 쓰지 않습니다. 예외는 그 컴퓨터의 Codex 로그인으로만 읽을 수 있는 사용량 표시(`codex-usage-live.yml`) 하나이고, PR 이벤트로는 돌지 않고 수동 실행도 `main`에서만 돌며, `main`의 `scripts/codex-usage-live.mjs` 하나만 받아 돌립니다(checkout을 하지 않아 리뷰 작업 폴더도 건드리지 않음). 수동 실행은 고른 브랜치의 워크플로 파일로 돌기 때문에, 이 워크플로를 바꾸는 PR은 리뷰에서 확인합니다.
  - 자동 리뷰는 PR의 대상 브랜치와 상관없이 기본 브랜치(`main`)의 `codex-review.yml` · `scripts/codex-review.sh`로 돕니다. 둘을 고치면 `main`에도 반영해야 자동 리뷰에 적용됩니다.
  - **러너 상태 알림**: 리뷰 컴퓨터 러너(`notelink-codex`)가 오프라인이 되거나 다시 온라인이 될 때, 온라인인데 Codex 리뷰가 30분 넘게 대기할 때, 러너 상태를 읽지 못할 때 디스코드로 알립니다. Codex 남은 사용량이 20% 미만이 되면 경고합니다. 10% 이하가 되거나 한도에 걸리면 리뷰 컴퓨터가 Codex 리뷰를 멈추고(PR 댓글 없이 실행 화면에 ⏸️ 경고만), 사용량이 초기화되면 멈췄던 리뷰 실행을 자동으로 다시 돌리고 알립니다(기준: `scripts/codex-usage-lib.sh`). 매일 09:00(서울) 무렵에는 아침 요약(지금 상태 · 대기 중인 리뷰 · 지난 24시간 리뷰 결과 · Codex 남은 사용량)을 보냅니다(`.github/workflows/runner-status.yml`, `scripts/runner-status.sh`). GitHub 클라우드 러너에서 15분마다 확인하므로 리뷰 컴퓨터가 멈춰도 알림은 옵니다. 비밀값 `DISCORD_RUNNER_WEBHOOK`(웹후크 주소)과 `RUNNER_STATUS_TOKEN`(러너 목록을 읽는 fine-grained PAT, Administration: Read-only)이 필요하고, 토큰 기한이 끝나면 ⚠️ 알림이 옵니다. Codex 사용량은 리뷰 컴퓨터가 리뷰를 마칠 때 세션 기록에서 뽑아 결과 파일 `codex-usage`로 올린 것(`scripts/codex-usage.mjs`, 사용률 · 초기화 시각 · 플랜 이름만)이라 리뷰가 돌 때만 새로 읽히고, 몇 시 리뷰 기준인지 함께 적습니다. Actions 탭의 "러너 상태 알림 → Run workflow"로 요약을 바로 보낼 수 있습니다. 예약 실행이라 `main`의 파일로 돕니다. 공개 저장소는 60일 동안 활동이 없으면 GitHub가 예약 실행을 끄므로(알림도 멈춤), 방학처럼 오래 쉬었다면 Actions 탭에서 이 워크플로가 켜져 있는지 확인합니다.
  - **Codex 사용량 표시**: 리뷰 컴퓨터 Codex 계정의 지금 남은 사용량(5시간 · 주간 창별 남은 양 · 초기화 시각(서울) · 플랜)을 디스코드 메시지 하나에 계속 고쳐 보여 줍니다(`.github/workflows/codex-usage-live.yml`, `scripts/codex-usage-live.mjs`). 리뷰 컴퓨터 러너에서 10분마다, Codex 리뷰가 끝날 때마다 `codex app-server`의 `account/rateLimits/read`로 읽으므로 토큰을 쓰지 않고, 리뷰가 돌지 않아도 갱신됩니다. 표시 기준은 러너 상태 알림과 같습니다(🟢 20% 이상 · 🟡 20% 미만 · ⏸️ 10% 이하 또는 한도). 처음 돌 때 메시지를 올리고 그 id를 리뷰 컴퓨터의 `~/.notelink/codex-usage-live.json`에 두며, 메시지를 지우면 다음 실행에서 새로 올립니다(채널에 고정해 두면 편합니다). 읽지 못하면 마지막 값과 ⚠️ 확인 실패 시각을 적고, 꼬리말에는 마지막으로 읽은 시각을 둡니다(오류 원문은 적지 않고 코드만). 러너가 꺼져 있으면 갱신이 멈추므로 메시지 꼬리말의 시각을 보고 판단합니다. 비밀값은 러너 상태 알림과 같은 `DISCORD_RUNNER_WEBHOOK`을 씁니다.

### 버전 · 보안

- 모든 패키지는 정확한 버전으로 고정하고, lock 파일은 커밋합니다.
- Expo 패키지는 `npx expo install`로 설치합니다.
- `.env`는 커밋하지 않습니다. 커밋하는 것은 배포 기준 예시 `.env.production`뿐이고, 실제 값은 넣지 않습니다(배포 값은 Azure App Service 앱 설정 · EAS에). API 키 같은 비밀값이 들어간 커밋은 GitHub push protection이 push 단계에서 막습니다.
- 소셜 로그인 시크릿 같은 비밀값은 **서버에만** 두고 앱에는 넣지 않습니다.
- **팀 개발용 `.env`는 Azure Key Vault에서 받습니다**(`scripts/env-vault.sh`). 키를 메시지나 파일로 따로 나누지 않습니다. Key Vault는 둘이고, 각자 자기 Azure 계정으로 엽니다(팀 키 하나를 나눠 갖지 않음).

  | Key Vault | 넣는 값 | 완우 · 희재 | 나머지 팀원 |
  | --- | --- | --- | --- |
  | 팀 `kv-notelink-team`(`NOTELINK_VAULT`) | 로컬 개발용 값(팀원이 봐도 되는 것) | 읽기 · 쓰기 | 읽기 · 쓰기(`Key Vault Secrets Officer`) |
  | 배포 `kv-notelink-dev`(`NOTELINK_DEPLOY_VAULT`, `--deploy`) | 배포 App Service가 Key Vault 참조로 읽는 값 · 개인 키 | 읽기 · 쓰기(`Key Vault Secrets Officer`) | 이름 보기 · 넣기만(사용자 지정 역할 `NoteLink Secrets Writer`, 값은 못 봄) |

  - 처음 한 번: Azure CLI 설치(Windows `winget install --exact --id Microsoft.AzureCLI`, Mac `brew install azure-cli`) → 터미널을 새로 열고 `az login --tenant <팀 테넌트 ID>`(팀 디렉터리에 초대된 계정으로). Windows에서 계정 선택 창이 멈추면 `az config set core.enable_broker_on_windows=false` 뒤 다시 로그인합니다.
  - 받기: `scripts/env-vault.sh pull ai`(또는 `api`) → 팀 Key Vault에서 `apps/<앱>/.env`가 만들어집니다. 그 앱의 `.env.production`에 적힌 변수 중 Key Vault에 있는 것만 받습니다. 손으로 만든 `.env`가 있었으면 `.env.bak`으로 남습니다. 이름만 보려면 `list`(`list ai`는 그 앱 것만).
  - Key Vault에 없는 값(로컬 DB 주소 · `APP_ENV=development` 같은 로컬 설정)과 내 값(개인 키)은 `apps/<앱>/.env.local`에 둡니다(`.env.production`의 `로컬:` 줄 참고). `pull`할 때 이 값이 받은 값 위에 덮어씁니다. 앱은 `.env`만 읽으므로 `.env.local`을 고친 뒤에는 `pull`을 다시 합니다. 둘 다 커밋하지 않습니다.
  - 넣기 · 바꾸기: `scripts/env-vault.sh push JWT_ACCESS_SECRET` → 값을 보이지 않게 입력합니다. secret 이름은 `_`만 `-`로 바꾼 것(`JWT-ACCESS-SECRET`)입니다. 바꾼 뒤 팀원은 `pull`을 다시 합니다.
  - 배포 값: `push --deploy <변수>` · `list --deploy`. 배포 App Service의 Key Vault 참조와 같은 secret이라, 앱을 다시 시작하면(아니면 24시간 안에) 새 값을 씁니다. `pull --deploy`는 값을 읽을 수 있는 완우 · 희재만 됩니다.
  - 로컬과 배포의 키를 나눠 두면, 로컬 키가 새거나 잘못 바뀌어도 배포 앱과 실제 데이터에는 닿지 않습니다. 따로 발급받을 수 없는 키(개인 키)는 배포 Key Vault에만 둡니다.

---

## 6. 결정 사항

| 항목 | 결정 |
| --- | --- |
| 실시간 통신 | Socket.IO 직접 (App Service에서 WebSocket 켜기) |
| 캠 · 음성 스터디 | 이번 학기 개발 (LiveKit Cloud) |
| 앱 차단 | Android 먼저, iOS는 Apple 승인 후 |
| 소셜 로그인 | 개발용 테스트 키부터 (카카오 · 네이버 · Google) |
| 결제 | 나중에 개발 (포인트 충전 · 요금제 결제만 미룸) |

## 7. 남은 일

- [ ] 요금제별 AI 사용 한도 — 요금제 기능 개발 때
- [ ] 필기 인식 비교 테스트 (Claude만 vs Document Intelligence + Claude) — 노트 개발 첫 주
- [ ] 캠 · 음성 스터디 화면 설계 — 스터디룸 담당
- [ ] 요구사항 FR-24의 하루 기준 시각을 자정으로 수정
- [ ] viseme ↔ FR-56 입 모양 연결표 — 아바타 담당
- [ ] 결제 방식 — 결제 개발 시작 때
