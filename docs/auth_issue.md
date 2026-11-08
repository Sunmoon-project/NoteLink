# 인증(소셜 로그인 · 이메일 가입/로그인) 작업 정리

> 서버(`apps/api`)의 인증 작업을 한곳에 모은 문서입니다. 다음 작업이나 인수인계 때 이 파일을 먼저 보세요.
> 작성 기준: `develop` `f589ee5` (#227 머지 후, 2026-11-08)

## 한 줄 요약

서버의 로그인 방식 세 가지(소셜, 이메일 가입, 이메일 로그인)와 토큰 갱신·로그아웃은 `develop`에 모두 들어 있습니다.
**남은 일은 실제 메일 발송 수단(ACS Email)과, 소셜 로그인의 실제 제공자 로그인 확인, 로그인 직후 API(약관 · 내 정보)입니다.**

## 현재 상태

| 항목 | 상태 | PR |
| --- | --- | --- |
| DB 연결 · JWT · 토큰 서비스 | 머지됨 | #139 |
| 구글 로그인 | 머지됨 | #171 |
| 카카오 · 네이버 로그인 + 토큰 갱신/로그아웃 엔드포인트 | 머지됨 | #174 |
| 이메일 가입 · 로그인 (FR-01-04) | 머지됨 | #227 |
| 메일 발송 수단 (ACS Email) | **코드 작성됨, 미머지** (`feature/FR-01-04-mail-acs`, 로컬 커밋 `047d6a3`) | 미생성 |
| 소셜 로그인 실제 제공자 로그인 확인 | **미완료** (아래 "확인 현황") | - |
| 약관 동의 `POST /auth/terms`, 내 정보 `GET/PATCH /users/me` | **미구현** | - |

## 엔드포인트

모든 주소는 `/api/v1` 접두사가 붙고, 성공 응답은 `{ data }`, 오류는 `{ code, message }`입니다.
토큰이 들어 있는 응답에는 `Cache-Control: no-store`가 붙습니다.

### 소셜 로그인 (구글 · 카카오 · 네이버)

| 메서드 | 주소 | 설명 |
| --- | --- | --- |
| GET | `/auth/social/:provider/start` | 앱이 시스템 브라우저로 여는 주소. 로그인 시도를 저장하고 제공자 로그인 화면으로 302 |
| GET | `/auth/social/:provider/callback` | 제공자가 사용자를 돌려보내는 주소. 1회용 코드를 만들어 `notelink://auth/callback?code=…&state=…`로 302 |
| POST | `/auth/social/:provider` | 앱이 `{ token, codeVerifier }`를 보내 토큰으로 교환. 응답 `{ data: { accessToken, refreshToken, user } }` |

흐름은 다음과 같습니다.

1. 앱이 `state`와 PKCE `code_challenge`(S256)를 만들어 `/start`를 엽니다. 두 값은 제공자에게 보내지 않고 서버에만 보관합니다(제공자에게는 서버가 따로 만든 state만 갑니다).
2. 제공자 로그인이 끝나면 `/callback`이 1회용 코드를 만들어 앱으로 돌려보냅니다. 코드는 2분 안에 한 번만 쓸 수 있습니다. 로그인 시도 자체는 10분 안에 끝나야 합니다.
3. 앱이 복귀 주소와 `state`가 정확히 맞는지 확인한 뒤 코드와 `codeVerifier`를 교환합니다. 서버는 코드를 찾으면서 동시에 지우므로, PKCE가 틀려도 코드는 이미 소모됩니다.

| 상황 | 응답 |
| --- | --- |
| 코드 없음 · 만료 · PKCE 불일치 · 탈퇴한 사용자 | 400 `VALIDATION_FAILED` |
| 같은 이메일로 이미 다른 방식의 계정이 있음 | 409 `ACCOUNT_EXISTS` (계정을 합치지 않고 안내만 함) |
| 지원하지 않는 제공자 | 404 |

제공자별 이메일 처리:

- 구글: `email_verified`가 정확히 `true`일 때만 이메일을 씁니다.
- 카카오: `is_email_valid`와 `is_email_verified`가 모두 `true`일 때만 씁니다. 동의하지 않아도 로그인은 됩니다.
- **네이버: 이메일을 저장하지 않습니다**(인증 여부를 알 수 없어 중복 계정 확인 기준으로 믿을 수 없기 때문). 이 정책은 에이전트가 정했고 팀에서 명시적으로 확정한 것은 아닙니다.

### 이메일 가입 · 로그인

| 메서드 | 주소 | 응답 | 설명 |
| --- | --- | --- | --- |
| POST | `/auth/email/send-code` | 204 | 6자리 인증번호를 메일로 보냄 |
| POST | `/auth/email/verify-code` | 200 `{ data: { verificationToken, expiresInSeconds } }` | 번호 확인. 가입용 증표(JWT) 발급 |
| POST | `/auth/email/signup` | 204 | `{ verificationToken, password }`로 가입. 토큰은 주지 않음 |
| POST | `/auth/email/login` | 200 `{ data: { accessToken, refreshToken, user } }` | 이메일 + 비밀번호 로그인 |

흐름: 이메일 입력 → 메일로 받은 인증번호 확인 → 비밀번호 설정 → 가입 → 로그인 화면에서 로그인.

인증번호:

- 6자리, 유효 10분, 틀리게 입력할 수 있는 횟수 5번, 재발송 간격 60초, 1시간에 5번까지 발송.
- DB에는 HMAC-SHA256 해시만 저장합니다(원문은 저장하지 않음). 횟수는 비교하기 **전에** 올립니다.
- `send-code`는 이미 가입한 이메일이어도 응답과 제한이 똑같습니다. 이 경우 번호 대신 "이미 가입된 이메일" 안내 메일이 갑니다(가입 여부를 화면으로 알려 주지 않음).
- 증표는 JWT(유효 10분)이고, 가입 때 한 번만 쓸 수 있습니다. 가입 요청 본문에는 이메일이 없고 증표 안의 이메일만 씁니다.

로그인:

- 비밀번호 규칙은 앱과 같이 8~64자, 공백 없음, 영문 + 숫자이며, 서버는 bcrypt 한계 때문에 72바이트 이하도 확인합니다. 해시는 bcrypt 비용 12입니다.
- 실패 사유(틀린 비밀번호 · 없는 이메일 · 소셜 전용 계정 · 탈퇴)는 모두 401 `INVALID_CREDENTIALS`로 같게 응답하고, 실패 경로마다 같은 비용의 bcrypt 비교를 해서 응답 시간 차이로 가입 여부를 알 수 없게 했습니다.
- 5번 틀리면 15분 동안 429 `LOGIN_LOCKED`(+`retryAfterSeconds`). 시도 횟수는 이메일 기준입니다.

오류 코드(`packages/shared`의 `ERROR_CODES`와 서버 `app-login-errors.ts`가 같은 값):
`EMAIL_CODE_INVALID`, `EMAIL_CODE_LOCKED`, `EMAIL_PROOF_EXPIRED`, `EMAIL_PROOF_INVALID`, `EMAIL_TAKEN`(409), `RATE_LIMITED`(429), `MAIL_UNAVAILABLE`(503), `INVALID_CREDENTIALS`(401), `LOGIN_LOCKED`(429).

### 토큰 (로그인 방식과 무관)

| 메서드 | 주소 | 설명 |
| --- | --- | --- |
| POST | `/auth/refresh` | refresh 토큰을 보내 새 토큰 한 쌍을 받음. 쓴 refresh 토큰은 폐기. 쓸 수 없으면 401 `AUTH_TOKEN_EXPIRED` |
| POST | `/auth/logout` | 보낸 기기의 refresh 토큰만 폐기. 항상 204 |

## DB 컬렉션

| 컬렉션 | 용도 | 비고 |
| --- | --- | --- |
| `users` | 사용자 | 소셜 · 이메일 계정 공통 |
| `refresh_tokens` | refresh 토큰 해시 | 기기마다 한 줄 |
| `social_login_attempts` | 소셜 로그인 진행 상태(`state`, PKCE 값, 1회용 코드 해시) | TTL로 정리 |
| `auth_codes` | 이메일 인증번호 상태 + 발송 횟수 기록 | 이메일 + 목적당 문서 1개, 재발송 때 덮어씀 |
| `login_attempts` | 이메일 로그인 실패 횟수 | 이메일당 1개, TTL로 정리 |

`auth_codes`의 시각 필드 세 개는 역할이 다릅니다. 섞어 쓰면 안 됩니다.

- `expiresAt`: 인증번호를 쓸 수 있는 마지막 시각(발송 + 10분)
- `windowEndsAt`: 발송 횟수를 세는 제한 구간의 끝(구간 시작 + 1시간). 재발송해도 늘어나지 않음
- `retainUntil`: MongoDB가 문서를 지우는 시각(TTL 인덱스). 위 둘과 인증 증표 수명 중 가장 늦은 때

발송(발급)마다 `issueId`가 새로 정해집니다. 확인이 비교를 끝내고 "썼다"고 표시하기 전에 재발급이 끼어들어도, 이전 번호의 성공이 새 번호를 쓴 것으로 만들지 못하게 하는 장치입니다.

**운영 전 확인할 것**

- 운영 DB에 `auth_codes` 문서가 이미 있으면 안 됩니다. 새 필드가 필수라서 옛 문서는 재발송 때 500이 나고 TTL로도 지워지지 않습니다.
- `FR-01-04` 브랜치로 서버를 띄운 적 있는 개발 DB에는 옛 TTL 인덱스 `windowEndsAt_1`이 남아 있을 수 있습니다. `db.auth_codes.dropIndex('windowEndsAt_1')`로 지우세요. 그대로 두면 구간 끝 무렵에 재발급한 번호가 유효 시간이 남았는데도 지워집니다.

## 리뷰에서 고친 것 (#227)

Codex 리뷰 지적을 코드로 확인하고 고쳤습니다(`9455c8c`).

1. 확인(`verify`)과 재발급이 겹치면 이전 번호의 성공이 새 번호까지 사용 처리했습니다. 발급 식별자(`issueId`)를 사용 처리 조건에 넣어 고쳤습니다. 실제 MongoDB에서 300번 경쟁시켰을 때 수정 전 297번 발생, 수정 후 0번이었습니다.
2. TTL이 발송 제한 구간 기준이라 구간 말미에 재발급한 번호가 유효한데도 지워졌습니다. 삭제 기준을 `retainUntil`로 분리했습니다. 실제 MongoDB TTL 모니터로 확인했습니다.
3. (리뷰에는 없던 추가 발견) 새 제한 구간으로 넘어갈 때 재발송 간격 60초를 확인하지 않던 문제도 함께 고쳤습니다.

## 설계 결정과 근거

- **인증번호 메일은 반드시 서버가 보냅니다.** 앱이 보내면 앱이 번호를 알게 되어 인증이 의미가 없어집니다.
- **메일 발송은 `MailSender` 인터페이스 뒤에 둡니다.** `MAIL_TRANSPORT=log`(개발 전용)로 명시했을 때만 서버 로그에 번호를 남기고, 그 밖의 값이나 미설정이면 발송을 거부(503 `MAIL_UNAVAILABLE`)합니다. `NODE_ENV`로 개발 환경을 추측하지 않는 이유는, 설정이 빠졌을 때 번호가 운영 로그에 남는 사고를 막기 위해서입니다.
- **IP 기준 제한은 넣지 않았습니다.** Azure 프록시와 `trust proxy` 설정을 확인하기 전에 넣으면 모든 사용자가 같은 IP로 보여 서로 막을 수 있습니다.
- **알려진 한계:** 로그인 제한이 이메일 기준이라, 남의 이메일을 일부러 5번 틀려서 15분 동안 잠글 수 있습니다.

## 기획서와 다른 점 (팀 확인 필요)

기획서 FR-01-04는 "인증번호만으로 가입 · 로그인(비밀번호 없음)"입니다. 앱 코드(이메일 + 비밀번호 로그인 화면)에 맞춰 서버는 "**인증번호로 가입하고 비밀번호로 로그인**"으로 구현했습니다. 팀이 이 방향을 확정해야 합니다.

## 확인 현황

**확인한 것**

- 서버 API 테스트 전체 통과(머지 시점 1416개, 리뷰 수정 후 1432개), 타입 검사 · lint · 빌드 통과.
- 실제 MongoDB로 동시성 확인: 같은 이메일로 로그인 200건 동시 → 정확히 5건 통과, 인증번호 50건 동시 발송 → 1건, 같은 증표 30건 동시 사용 → 1건, 가입 10건 동시 → 1건.
- 소셜 `/start`: 서버를 실제로 띄우고 세 제공자 모두 올바른 로그인 화면(구글 · 카카오 · 네이버)으로 302되는 것을 확인했습니다. 앱이 보내는 것과 같은 형식의 `redirect` · `state` · `code_challenge`로 호출했고, `redirect_uri`가 `.env` 값과 같았습니다.
- 앱(`apps/mobile/src/lib/social-auth.ts`)과 서버의 소셜 규약(시작 주소, state, PKCE, 복귀 주소 `notelink://auth/callback`)이 코드상 일치합니다.

**확인하지 못한 것**

- **실제 제공자 로그인 → 코드 교환까지의 전체 흐름**은 아직 해 보지 않았습니다. 브라우저에서 직접 로그인해야 하는 단계입니다.
- **실제 메일 발송.** ACS 키가 없어 SDK를 로컬 가짜 서버에 붙여서만 확인했습니다(접수, 401, 429, 무응답). 네이버 · 다음 포털에서 스팸함으로 가는지도 모릅니다.
- 앱 화면에서 가입 · 로그인이 이어지는지(프론트 연결)는 확인하지 않았습니다.

## 소셜 로그인 실제 확인 방법

```bash
# 1) 서버 실행 (임시 DB 사용 예시)
docker run -d --rm --name nl-tmp-mongo -p 27018:27017 mongo:8.0
cd apps/api && npm run build
MONGODB_URI=mongodb://localhost:27018/notelink-social-check node dist/main.js

# 2) 시작 주소 만들기 → 브라우저에 붙여 넣고 로그인
python3 /tmp/social-check.py start google     # 또는 kakao, naver

# 3) 로그인 후 브라우저가 이동하려는 notelink://auth/callback?code=…&state=… 를 복사해 교환
python3 /tmp/social-check.py exchange google 'notelink://auth/callback?code=…&state=…'
```

`/tmp/social-check.py`는 저장소 밖 임시 도구라 사라졌을 수 있습니다. 필요한 동작은 위 세 단계(시작 주소 생성 → 로그인 → 코드 교환)뿐입니다.

확인 전에 점검할 것:

- 각 개발자 콘솔의 리디렉션 주소가 `.env`의 `*_REDIRECT_URI`와 글자까지 같아야 합니다(구글 예: `http://localhost:3000/api/v1/auth/social/google/callback`). 다르면 `redirect_uri_mismatch` 같은 오류가 납니다.
- 카카오 · 네이버 앱이 "개발 중" 상태면 콘솔에 등록된 테스트 계정으로만 로그인됩니다.
- 실기기에서 쓰려면 `localhost`가 아닌 기기가 닿는 서버 주소가 필요합니다(`apps/mobile`의 `EXPO_PUBLIC_API_URL`, 서버의 `*_REDIRECT_URI`).
- 앱에서 간편 로그인 버튼을 켜려면 `apps/mobile/.env`의 `EXPO_PUBLIC_SOCIAL_LOGIN=true`가 필요합니다(기본값 `false`).

## 환경변수

값은 `apps/api/.env`에만 두고 커밋하지 않습니다. 이름과 설명은 `apps/api/.env.example`을 보세요.

- 공통: `MONGODB_URI`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`
- 구글: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`
- 카카오: `KAKAO_REST_API_KEY`, `KAKAO_CLIENT_SECRET`, `KAKAO_REDIRECT_URI`
- 네이버: `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET`, `NAVER_REDIRECT_URI`
- 메일: `MAIL_TRANSPORT`(지금 `develop`에서는 `log` 또는 비움). `acs`와 `ACS_CONNECTION_STRING`, `MAIL_FROM`은 ACS PR이 머지된 뒤에 씁니다.

## 다음 할 일

1. **소셜 로그인 실제 확인**: 위 방법으로 구글 · 카카오 · 네이버를 각각 한 번씩 로그인해 보고, 결과를 이 문서의 "확인 현황"에 갱신합니다.
2. **ACS 메일 발송 PR**: `feature/FR-01-04-mail-acs`를 `develop` 위로 rebase해서 올립니다(`@azure/communication-email` 1.1.0, 10초 제한 시간, 연결 문자열은 로그와 오류 문구에 남기지 않음). 먼저 Azure에서 Communication Services와 이메일 서비스 리소스를 만들고 도메인을 연결해야 합니다. Azure 관리 도메인(`azurecomm.net`)은 테스트용이라 한도가 낮고(기본 분당 30통 · 시간당 100통), 한도 상향은 직접 인증한 커스텀 도메인에서만 됩니다.
3. **로그인 직후 API**: `POST /auth/terms`, `GET/PATCH /users/me`. 경로는 `packages/shared`에만 있고 서버 구현이 없어서, 로그인이 성공해도 앱이 다음 화면에서 막힙니다.
4. **프론트엔드 연결**(프론트 담당): 가입 3단계 화면(이메일 → 인증번호 → 비밀번호), `PATHS` · `ERROR_CODES` 연결, 비밀번호 72바이트 확인(앱은 글자 수만 확인), `EXPO_PUBLIC_SOCIAL_LOGIN=true`.
5. **팀 결정 필요**: FR-01-04 방향(위 "기획서와 다른 점"), 네이버 이메일 정책, 운영 메일 도메인.
6. **아직 구현하지 않은 것**: 비밀번호 재설정 · 변경, 회원 탈퇴, 닉네임 중복 확인, 계정 합치기, IP 기준 제한(프록시 설정 확인 후).
