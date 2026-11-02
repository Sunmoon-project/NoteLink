# 데이터베이스 설계

NoteLink는 **MongoDB**(Atlas, 코리아 중부 리전)를 사용합니다. 모든 데이터는 **NestJS 서버만** 읽고 씁니다. FastAPI(AI 서버)는 예외적으로 `ai_jobs` 컬렉션만 다룹니다.

- 컬렉션 이름: `snake_case` 복수형 (`study_rooms`, `refresh_tokens`)
- 필드 이름: `camelCase` (`inviteCode`, `createdAt`)
- 시간: UTC로 저장. "오늘"은 서울 기준 자정(`DAY_RESET_HOUR = 0`)으로 계산
- 파일(사진·녹음·PDF)은 Azure Blob에 올리고, DB에는 **주소만** 저장

---

## 1. 도메인 구성 (6개 그룹 · 컬렉션 35개)

발표 자료 기준으로 컬렉션을 6개 도메인으로 나눕니다.

| # | 도메인 | 주요 컬렉션 |
| --- | --- | --- |
| 1 | 회원 · 인증 | `users`, `refresh_tokens`, `auth_codes`, `user_devices`, `categories`, `inquiries`, `notifications` |
| 2 | 상점 · 포인트 · 결제 | `shop_items`, `user_items`, `point_ledger`, `payments` |
| 3 | 노트 · 퀴즈 · AI | `materials`, `folders`, `recordings`, `flashcards`, `quiz_sets`, `quiz_attempts`, `ai_jobs` |
| 4 | 학습 기록 · 목표 | `study_sessions`, `daily_records`, `subjects`, `weekly_goals`, `recurring_goals`, `goal_results` |
| 5 | 일정 · 캘린더 · 시간표 | `todos`, `calendar_shares`, `timetables`, `timetable_shares`, `public_holidays` |
| 6 | 스터디룸 · 채팅 · 소셜 | `study_rooms`, `room_shared_items`, `chat_rooms`, `messages`, `friendships`, `reports` |

> 이 문서에서는 **현재 구현된** 도메인(회원·인증, 스터디룸·채팅)을 중심으로 상세히 다룹니다. 나머지 컬렉션은 스키마 파일만 정의된 상태입니다.

---

## 2. 데이터 흐름 원칙

```
모바일 앱 ──REST · Socket.IO──▶ NestJS 서버 ──▶ MongoDB
   │                              │  ▲
   │                              ▼  │ (ai_jobs만)
   │                           FastAPI ──▶ Claude · Azure
   └── 사진·녹음·PDF 직접 업로드 ──▶ Azure Blob Storage
```

- 앱은 **NestJS 서버만** 호출한다.
- DB는 **NestJS가 관리**하고, FastAPI는 `ai_jobs`만 읽고 쓴다.
- 오래 걸리는 AI 작업은 `ai_jobs`(작업 큐)에 넣고, 진행률은 Socket.IO로 전달한다.

---

## 3. 회원 · 인증 도메인 (구현됨)

### `users`

사용자 계정. 소셜 계정·약관 동의·구독 정보를 **임베디드 문서**로 품는다.

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `_id` | ObjectId | |
| `email` | string? | 소셜 전용 가입자는 없을 수 있음 |
| `passwordHash` | string? | **bcrypt 해시**. 평문은 저장하지 않음 |
| `nickname` | string | |
| `role` | string | 시스템 권한 (`user` 기본, `admin`) |
| `learnerType` | string? | 중·고등학생 / 대학생 / 직장인 |
| `pointBalance` | int | 보유 포인트 |
| `settings` | object | 환경설정 |
| `status` | string | `active` 등 |
| `interestCategoryIds` | ObjectId[] | `categories` 참조 |
| `socialAccounts` | SocialAccount[] | 임베디드 (provider, providerUid, email, linkedAt) |
| `termAgreements` | TermAgreement[] | 임베디드 (termCode, version, agreed, agreedAt) |
| `subscription` | Subscription? | 임베디드 (tier, status, period, autoRenew …) |
| `lastLoginAt` | date? | |
| `deletedAt` | date? | soft delete |
| `createdAt` / `updatedAt` | date | timestamps |

### `refresh_tokens`

로그인 세션 추적. **원본 토큰 대신 해시만** 저장한다.

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `userId` | ObjectId → users | |
| `tokenHash` | string (unique) | refresh 토큰의 SHA-256 해시 |
| `device` | object? | 기기 정보 |
| `expiresAt` | date | 만료 시각 |
| `revokedAt` | date? | 폐기 시각 (유효한 토큰은 없음) |

> 토큰을 쓸 때마다 **회전**한다: 기존 토큰을 `revokedAt` 처리하고 새 토큰을 발급.

### `auth_codes`

이메일 인증번호 (가입·비번찾기 등). `email`, `purpose`, `codeHash`, `attempts`, `expiresAt`.

---

## 4. 스터디룸 · 채팅 도메인 (구현됨)

### `study_rooms`

스터디룸 본체. 참여 멤버를 **임베디드 배열**로 품는다.

| 필드 | 타입 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `_id` | ObjectId | | |
| `title` | string | | 방 이름 |
| `categoryId` | ObjectId → categories | | 카테고리 |
| `hostId` | ObjectId → users | | 현재 방장 |
| `isPublic` | boolean | `true` | 공개 여부 (목록 노출 기준) |
| `inviteCode` | string (unique) | | **서버가 생성**하는 6자리 입장 코드 |
| `maxCapacity` | int | `6` | 최대 인원 |
| `memberCount` | int | `1` | 현재 참여 인원 |
| `timerRule` | object? | | 뽀모도로 타이머 규칙 |
| `members` | RoomMember[] | `[]` | 참여 멤버 (임베디드) |
| `closedAt` | date? | | 방이 닫힌 시각 |
| `createdAt` / `updatedAt` | date | | timestamps |

#### `RoomMember` (임베디드)

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `userId` | ObjectId → users | |
| `role` | string | `host` / `member` (방 안에서의 역할) |
| `status` | string | `joined` / `left` / `kicked` |
| `personalTimerRule` | object? | 개인 타이머 규칙 |
| `invitedAt` / `joinedAt` / `leftAt` / `kickedAt` | date? | 생명주기 타임스탬프 |

> **중요 — 두 종류의 role 구분**
> - `users.role` = **시스템 전역 권한** (`user` / `admin`)
> - `RoomMember.role` = **방 안에서의 역할** (`host` / `member`)
>
> 둘은 완전히 다른 개념이라 상수도 분리돼 있다 (`ROLES` vs `ROOM_MEMBER_ROLES`).

### `chat_rooms`

채팅방. 스터디룸과 1:1로 연결된다 (`studyRoomId`).

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `type` | string | `study_room`(그룹) / `direct`(1:1) |
| `studyRoomId` | ObjectId → study_rooms | 연결된 스터디룸 |
| `lastMessage` | object? | 방 목록에 보여줄 마지막 메시지 요약 |
| `members` | ChatMember[] | 채팅 참여 유저 (joinedAt, lastReadAt, muted …) |
| `title` | string? | |

### `messages`

채팅 메시지. 수정하지 않으므로 `updatedAt`은 두지 않는다.

| 필드 | 타입 | 설명 |
| --- | --- | --- |
| `chatRoomId` | ObjectId → chat_rooms | |
| `senderId` | ObjectId → users | 보낸 사람 |
| `type` | string | `text` / `system` / `shared_item` |
| `text` | string? | 본문 |
| `sharedItemId` | ObjectId? | 공유 자료 메시지일 때 |
| `sharePreview` | object? | 공유 미리보기 |
| `deletedAt` | date? | soft delete |
| `createdAt` | date | timestamps (createdAt만) |

**인덱스**: `{ chatRoomId: 1, _id: -1 }`
→ "이 방의 메시지를 최신순으로" 조회에 최적화. ObjectId(`_id`)는 생성 시각이 앞부분에 인코딩돼 있어 **시간순 정렬·커서**로 안전하게 쓸 수 있다.

---

## 5. 참조(ref) 관계 요약

```
users ──┬── refresh_tokens (userId)
        ├── study_rooms (hostId, members[].userId)
        └── messages (senderId)

categories ── study_rooms (categoryId)

study_rooms ── chat_rooms (studyRoomId) ── messages (chatRoomId)
```

MongoDB는 조인이 없으므로, 참조는 ObjectId로 저장하고 필요 시 애플리케이션에서 조회한다.

---

## 6. 네이밍·규칙 체크리스트

- [x] 컬렉션 `snake_case` 복수형
- [x] 필드 `camelCase`
- [x] 비밀값(비번·토큰)은 해시로만 저장
- [x] soft delete는 `deletedAt` / 방은 `closedAt`
- [x] timestamps(`createdAt`/`updatedAt`)는 Mongoose가 자동 관리
