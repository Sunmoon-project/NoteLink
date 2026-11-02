# 스터디룸 기능

발표 자료 p.74~81 기준. 스터디룸의 **만들기 · 목록 · 입장 · 나가기 · 실시간 채팅 · 히스토리**를 담당한다.

- 모듈 위치: `apps/api/src/modules/studyroom/`
- 게이트웨이: `apps/api/src/realtime/chat.gateway.ts`
- 관련 컬렉션: `study_rooms`, `chat_rooms`, `messages` (→ [database.md](./database.md))

---

## 1. 파일 구조

```
modules/studyroom/
├─ dto/
│  ├─ create-study-room.dto.ts    방 만들기 입력 (title, categoryId, isPublic, maxCapacity?)
│  ├─ join-study-room.dto.ts      코드 입장 입력 (inviteCode)
│  ├─ list-study-rooms.dto.ts     목록 조회 쿼리 (limit)
│  └─ list-messages.dto.ts        히스토리 조회 쿼리 (limit, before)
├─ schemas/
│  └─ study-room.schema.ts        study_rooms 컬렉션 (+ RoomMember 임베디드)
├─ study-room.constants.ts        ROOM_MEMBER_ROLES / ROOM_MEMBER_STATUS
├─ chat.events.ts                 CHAT_EVENTS / MESSAGE_TYPES
├─ studyroom.service.ts           create / list / joinByCode / leave
├─ chat.service.ts                assertMember / saveMessage / getHistory
├─ studyroom.controller.ts        REST 엔드포인트 (창구)
└─ studyroom.module.ts            배선

realtime/
└─ chat.gateway.ts                Socket.IO 게이트웨이
```

**역할 분리 원칙**
- Controller / Gateway = 요청을 받는 "창구" (라우팅·검증)
- Service = 실제 로직 (DB 접근, 비즈니스 규칙)

---

## 2. 엔드포인트 한눈에

| 방식 | 주소 / 이벤트 | 하는 일 | 발표자료 |
| --- | --- | --- | --- |
| REST | `POST /api/v1/study-rooms` | 방 만들기 | p.75-3 |
| REST | `GET /api/v1/study-rooms` | 공개방 목록 | p.75-1 |
| REST | `POST /api/v1/study-rooms/join` | 코드로 입장 | p.75-2 |
| REST | `POST /api/v1/study-rooms/:id/leave` | 방 나가기 | p.81 |
| REST | `GET /api/v1/study-rooms/:id/messages` | 채팅 히스토리 | — |
| Socket | `chat:join` / `chat:send` / `chat:message` | 실시간 채팅 | p.76 |

> 모든 REST 엔드포인트는 **로그인 필요**(`JwtAuthGuard`, 컨트롤러 레벨 적용).
> 응답은 성공 `{ data }`, 오류 `{ code, message }`.

---

## 3. 방 만들기 — `POST /study-rooms`

```
앱: { title, categoryId, isPublic, maxCapacity? }
      ↓  (CreateStudyRoomDto 검증)
서버:
  1. inviteCode 자동 생성 (6자리, 중복 방지)
  2. hostId = 토큰에서 꺼낸 로그인 사용자  ← 앱이 보낸 값 아님(보안)
  3. 만든 사람을 host 멤버로 members[0]에 추가
  4. memberCount = 1 로 study_rooms 저장
      ↓
응답: { data: { id, title, inviteCode, isPublic, maxCapacity, memberCount, ... } }
```

- **inviteCode는 서버가 만든다.** 앱은 보내지 않는다. 헷갈리는 문자(0/O, 1/I)를 뺀 6자리.
- host는 앱이 지정하지 못한다. 반드시 **토큰의 사용자**가 host가 된다.

---

## 4. 목록 조회 — `GET /study-rooms`

```
GET /study-rooms?limit=20
      ↓
서버: find({ isPublic: true, closedAt 없음 })
        .sort({ createdAt: -1 })   // 최신순
        .limit(20)                 // 최대 50
      ↓
응답: { data: [ {room}, {room}, ... ] }
```

- **공개방만** 나온다. 비공개방(`isPublic: false`)은 목록에 없고 **코드로만** 입장한다.
- 닫힌 방(`closedAt` 있음)은 제외.

---

## 5. 코드로 입장 — `POST /study-rooms/join`

```
앱: { inviteCode }
      ↓
서버:
  1. 코드를 대문자로 변환해 방 조회
  2. 없거나 닫힌 방 → ROOM_NOT_FOUND
  3. 이미 참여 중(joined) → 그냥 방 정보 반환 (중복 방지)
  4. 정원(maxCapacity) 초과 → ROOM_FULL
  5. 이전에 나갔던(left) 사람 → 기록 복원 (left → joined)
     처음 온 사람 → members에 role=member 추가
  6. memberCount + 1 저장
```

- 코드는 방의 **"열쇠"**다. 공개/비공개 상관없이 코드만 맞으면 입장한다.
  (`isPublic`은 목록 노출 여부만 결정하고, 코드 입장은 막지 않는다.)

**오류 코드**

| 코드 | 상황 |
| --- | --- |
| `ROOM_NOT_FOUND` | 없는 코드 / 닫힌 방 |
| `ROOM_FULL` | 정원 초과 |

---

## 6. 방 나가기 — `POST /study-rooms/:id/leave`

```
서버:
  1. 참여 멤버가 아니면 → NOT_A_MEMBER
  2. 본인 status = left, leftAt 기록, memberCount - 1
  3. 남은 멤버 판단:
     - 아무도 없음        → 방을 닫음 (closedAt), 응답 { closed: true }
     - host가 나갔고 남음  → 가장 먼저 들어온 멤버에게 host 위임 (hostId 변경)
     - 일반 멤버가 나감    → 그대로, 응답 { closed: false }
```

**host 위임 규칙**: host가 나가면 남은 멤버 중 **가장 먼저 들어온 사람**이 새 host가 된다. 혼자였다면 방이 닫힌다.

---

## 7. 실시간 채팅 (Socket.IO)

REST가 "경로"로 분기한다면, 채팅은 **"이벤트 이름"으로 분기**한다.

### 연결 & 인증

```
앱: io('/chat', { auth: { token: <accessToken> } })
      ↓
게이트웨이 handleConnection:
  - 핸드셰이크에서 JWT 추출 → 검증
  - 성공: socket.data.userId 저장
  - 실패: chat:error 보내고 연결 끊음
```

### 이벤트 (chat.events.ts)

| 방향 | 이벤트 | payload | 하는 일 |
| --- | --- | --- | --- |
| 앱→서버 | `chat:join` | `{ roomId }` | 멤버 확인 후 소켓 룸 입장 |
| 앱→서버 | `chat:leave` | `{ roomId }` | 소켓 룸에서 나감 |
| 앱→서버 | `chat:send` | `{ roomId, text }` | 메시지 저장 + 방송 |
| 서버→앱 | `chat:message` | `{message}` | 새 메시지 수신 |
| 서버→앱 | `chat:joined` | `{ roomId }` | 입장 확인 |
| 서버→앱 | `chat:error` | `{ code, message }` | 오류 |

### 메시지 전송 흐름 (`chat:send`)

```
앱: chat:send { roomId, text }
      ↓
게이트웨이:
  1. 빈 메시지면 chat:error (EMPTY_MESSAGE)
  2. assertMember() — 그 방 참여 멤버인지 확인 (외부인 차단)
  3. chatService.saveMessage() — messages에 저장 + chat_room.lastMessage 갱신
  4. server.to('study-room:<roomId>').emit('chat:message', 저장된메시지)
      ↓
같은 방의 모든 소켓: chat:message 로 실시간 수신
```

- **멤버만** 메시지를 보낼 수 있다 (`assertMember`로 매 전송마다 확인).
- 소켓 룸 이름은 `study-room:<roomId>`.
- chat_room은 첫 메시지 때 **자동 생성**된다.

---

## 8. 채팅 히스토리 — `GET /study-rooms/:id/messages`

위로 스크롤하며 과거를 불러오는 **커서 기반 페이지네이션**.

```
GET /study-rooms/:id/messages?limit=30            → 최신 30개
GET /study-rooms/:id/messages?limit=30&before=<messageId>  → 그 이전 30개
      ↓
서버:
  1. assertMember() — 참여 멤버만 조회 가능
  2. find({ chatRoomId, deletedAt 없음, _id < before })
       .sort({ _id: -1 }).limit(30)
  3. 오래된→최신 순으로 뒤집어 반환
```

**왜 `createdAt`이 아니라 `_id`로 정렬·커서를 쓰나**
- `createdAt`(밀리초)만 쓰면 같은 밀리초에 온 메시지 순서가 뒤집힐 수 있다.
- ObjectId(`_id`)는 생성 시각이 앞부분에 인코딩돼 있어 **시간순이 보장**되고, tie-break까지 해결된다.

**왜 offset/skip이 아니라 커서(before)인가**
- offset 방식은 새 메시지가 들어오면 페이지가 밀려 중복·누락이 생긴다.
- `before=<id>` 커서는 "이 메시지보다 이전"을 가리키므로 새 메시지에 영향받지 않는다.

---

## 9. 권한 · 보안 요약

| 보호 대상 | 방법 |
| --- | --- |
| REST 전체 | `JwtAuthGuard` (로그인 필수) |
| 소켓 연결 | 핸드셰이크 JWT 검증, 실패 시 연결 끊음 |
| 채팅 전송/조회 | `assertMember` — 그 방 참여 멤버만 |
| host 지정 | 앱이 못 정함. 방 생성자 또는 위임으로만 |

---

## 10. 테스트

- `studyroom.service.test.ts` — create / list / join / leave (18개)
- `chat.service.test.ts` — assertMember / saveMessage / getHistory (9개)
- 실시간 채팅·히스토리 커서는 로컬 MongoDB + socket.io-client로 end-to-end 검증

---

## 11. 아직 안 한 것

- 입장/퇴장 **시스템 메시지** (`messages.type = 'system'`)
- **읽음 표시** (`ChatMember.lastReadAt`)
- **강퇴** (멤버 `status = kicked`)
- **신고** (p.78, `reports` 컬렉션)
- **캠 · 음성** (LiveKit, p.76)
- 앱(React Native)에서의 호출 + 로컬 캐시
