# 노트 탭 파일 올리기 (필기 · 문서 · 녹음)

노트 탭에서 필기 사진, 문서(PDF · 사진), 강의 녹음을 올려 AI 정리본을 받는 흐름을 정리합니다.
앱 · NestJS(api) · FastAPI(ai) · Azure Blob이 어떤 순서로 통신하는지, 어디서 막히는지, 어떻게 풀어야 하는지를 다룹니다.

> 이 문서는 `feature/FR-19-image-check-api` 브랜치의 코드를 기준으로 썼습니다.
> 실제 Azure(Blob · Document Intelligence)에 붙여 본 결과는 아니므로, 그런 항목은 "확인 필요"로 표시했습니다.

---

## 1. 한눈에 보기

```
앱(Expo) ──① POST /uploads/sas ───────────────▶ NestJS ── SAS 주소를 계산해서 돌려줌(Azure 호출 없음)
   │
   ├────② PUT uploadUrl (파일 본문) ───────────▶ Azure Blob  (서버를 거치지 않음)
   │
   ├────③ POST /images/check (필기 사진만) ────▶ NestJS ──읽기 SAS 발급──▶ FastAPI ──▶ Azure Document Intelligence
   │                                                       (/internal/v1/images/check)
   ├────④ POST /materials ─────────────────────▶ NestJS ── materials 저장 + ai_jobs 등록
   │
   └────⑤ Socket.IO ai:progress · ai:done, GET /ai-jobs/:id ──▶ NestJS ◀── FastAPI 처리기가 ai_jobs 갱신
```

| 규칙 | 지키는 방법 |
| --- | --- |
| 앱은 NestJS만 호출한다 | 앱이 부르는 API는 모두 `/api/v1/...`. FastAPI 주소는 앱이 모른다 |
| 파일은 앱이 Blob에 직접 올리고 DB에는 주소만 둔다 | ①②로 올리고, ④에서 `blobUrls`만 저장 |
| 비밀값은 서버에만 둔다 | 스토리지 연결 문자열 · `AI_INTERNAL_TOKEN`은 api · ai의 환경 변수에만 있다 |
| FastAPI는 `ai_jobs`만 읽고 쓴다 | 사진 검사(`images.py`)는 DB를 쓰지 않는다 |

---

## 2. 종류별 업로드

| 노트 종류(`kind`) | 올리는 파일 | 업로드 종류(SAS `kind`) | 허용 확장자 | 최대 크기 | AI 작업 |
| --- | --- | --- | --- | --- | --- |
| `handwriting` (필기) | 사진 여러 장 | `image` | jpg · jpeg · png · heic | 20MB | `handwriting_summary` |
| `document` (문서) | PDF 1개 또는 사진 여러 장 | `document` | pdf · jpg · jpeg · png | 50MB | `handwriting_summary` |
| `recording` (녹음) | 오디오 1개 | `audio` | mp3 · m4a · aac · mp4 · wav | 500MB | `recording_summary` |

- 한 번에 올리는 파일은 최대 50개(`MATERIAL_MAX_FILES`)입니다.
- PDF는 다른 파일과 함께 올릴 수 없고, 녹음은 파일 하나만 올릴 수 있습니다.
- 같은 파일 주소를 두 번 넣을 수 없습니다.
- 값의 출처는 `packages/shared`의 `UPLOAD_RULES`이고, 앱과 서버가 같은 값을 씁니다.

---

## 3. 동작 순서

### ① 기기에서 먼저 확인 (앱)

`apps/mobile/src/lib/upload.ts`의 `checkFile`이 확장자와 크기를 먼저 봅니다. 통과하지 못한 파일은 서버로 보내지 않습니다.
`uploadToBlob`도 올리기 직전에 같은 검사를 다시 합니다.

### ② 업로드 주소 받기: `POST /api/v1/uploads/sas`

요청:

```json
{ "kind": "image", "fileName": "note.jpg", "contentType": "image/jpeg", "sizeBytes": 1234567 }
```

응답(`apps/api/src/modules/upload`):

```json
{ "data": {
  "uploadUrl": "https://<계정>.blob.core.windows.net/<컨테이너>/uploads/image/<userId>/<uuid>.jpg?<sas>",
  "blobUrl":   "https://<계정>.blob.core.windows.net/<컨테이너>/uploads/image/<userId>/<uuid>.jpg",
  "expiresAt": "2026-…Z",
  "headers": { "x-ms-blob-type": "BlockBlob", "Content-Type": "image/jpeg" }
} }
```

- 서버는 확장자 · 크기를 `UPLOAD_RULES`로 다시 검증합니다. 맞지 않으면 `400 FILE_NOT_ALLOWED`입니다. `contentType`이 허용 목록에 없으면 거절하지 않고 확장자의 표준 형식을 `headers`의 `Content-Type`으로 돌려줍니다.
- 적어 보낸 `sizeBytes`는 앱이 알린 값일 뿐이고 SAS로는 크기를 묶을 수 없습니다. 실제 크기는 쓰는 곳(노트 등록 · 사진 검사 · 신고 접수)이 저장소에서 다시 확인합니다.
- 파일 이름은 서버가 UUID로 새로 만듭니다. 경로는 `uploads/{kind}/{userId}/{uuid}.{확장자}`입니다. 신고 사진(`"purpose": "report"`, 이미지만)은 임시 경로 `incoming/{userId}/{uuid}.{확장자}`에 올립니다.
- SAS는 **만들기(`c`) 권한만**, **HTTPS만**(로컬 에뮬레이터 주소일 때만 http 허용), **15분**(`UPLOAD_SAS_MINUTES`)입니다. 같은 주소로 덮어쓰거나 읽거나 지울 수 없습니다.
- 발급은 사용자마다 10분에 100번까지입니다(`UPLOAD_ISSUE_LIMIT`). 넘으면 `429 RATE_LIMITED`와 `retryAfterSeconds`를 돌려줍니다. 거절한 요청은 세지 않습니다.
- 서버는 이 주소를 **자기 키로 계산**할 뿐 Azure에 묻지 않습니다. 그래서 서버에 스토리지 키(연결 문자열)가 있어야 합니다.

### ③ Blob에 직접 올리기 (앱 → Azure)

`file.createUploadTask(uploadUrl, { httpMethod: 'PUT', headers, mimeType })`로 올립니다.
`x-ms-blob-type: BlockBlob` 헤더와 `Content-Type`이 필요합니다.

- 앱은 응답 상태가 2xx가 아니면 `UploadError`를 냅니다(Expo의 `uploadAsync`는 403도 resolve하기 때문).
- 올라간 뒤 앱이 기억하는 것은 `blobUrl`(SAS 없는 주소)뿐입니다.
- 끊기면 이미 올린 파일(`useDraft.uploads`)은 건너뛰고 이어서 올립니다.

### ④ 필기 사진 검사 (필기 사진만): `POST /api/v1/images/check`

글씨로 읽을 수 있는 사진인지 등록 전에 미리 확인합니다. 화면: `features/content/capture.tsx`.

요청(`apps/api/src/modules/content/images`):

```json
{ "files": [ { "name": "0-note.jpg", "sizeBytes": 1234567, "uri": "<blobUrl>" } ] }
```

- `name`은 파일마다 달라야 합니다(앱은 `인덱스-원본이름`으로 붙입니다). 최대 20장, 크기 20MB 이하입니다.
- 응답: `{ "data": [ { "name": "0-note.jpg", "verdict": "ok" } ] }`

| `verdict` | 뜻 | 앱 동작 |
| --- | --- | --- |
| `ok` | 필기로 읽힘 | 그대로 진행 |
| `blurry` | 글씨 인식 신뢰도가 낮음 | 다시 찍기 안내 |
| `not_handwriting` | 필기가 아님(인쇄물 · 빈 사진) | 안내 후 제외 가능 |
| `not_allowed` | OCR이 파일을 거절 | 제외 |

서버 안에서는 이렇게 흘러갑니다.

1. Nest `ImagesService.check`가 본문을 검증합니다(`CheckImagesBody`, 중복 이름 · 크기 초과는 400).
2. `BlobStorageService.createImageCheckReadUrl`이 **내 업로드인지** 확인하고(`uploads/image/{내 userId}/{uuid4}.{ext}`, 파일이 실제로 있는지, 크기, Content-Type이 확장자와 맞는지) **15분짜리 읽기 전용 SAS**를 만듭니다. 남의 파일이면 400입니다.
3. Nest가 `AI_INTERNAL_URL/internal/v1/images/check`로 `Authorization: Bearer AI_INTERNAL_TOKEN`과 함께 보냅니다. **제한 시간은 90초**(`AbortSignal.timeout(90_000)`)입니다.
4. FastAPI `images.py`가 토큰을 확인하고(`_authorize`), 파일을 **최대 4개씩 동시에**(`MAX_WORKERS`) Azure Document Intelligence에 읽힙니다(`_check`).
5. `verdict_from_read`가 OCR 결과를 판정으로 바꿉니다.
6. Nest가 응답을 다시 검증합니다. 요청한 이름과 정확히 한 번씩 일치하지 않거나 모르는 판정이면 `503 AI_UNAVAILABLE`입니다.

판정 기준(`apps/ai/app/services/image_check.py`):

| 순서 | 조건 | 판정 |
| --- | --- | --- |
| 1 | 글 내용이 비었거나 문자열이 아님 | `not_handwriting` |
| 2 | 단어 신뢰도(0~1) 평균 **< 0.45** (`MIN_OCR_CONFIDENCE`) | `blurry` |
| 3 | 필기 글자 수 **≥ 3** (`MIN_HANDWRITTEN_CHARS`) | `ok` |
| 4 | 그 밖 | `not_handwriting` |

- 신뢰도는 0 이상 1 이하의 숫자만 평균에 넣고, 범위 밖이거나 숫자가 아니면 무시합니다. 신뢰도 정보가 아예 없으면 흐림으로 보지 않습니다.
- 흐림 판정이 필기 글자 수 확인보다 먼저입니다.
- OCR이 파일을 거절(`OcrError`)하면 그 파일만 `not_allowed`, 일시 오류 · 설정 오류면 배치 전체가 503입니다.

### ⑤ 노트 등록: `POST /api/v1/materials`

헤더 `Idempotency-Key`(공백 없는 ASCII 128자 이하)를 붙입니다. 앱은 `requestId`로 보냅니다.

```json
{ "folderId": "<폴더 id>", "kind": "handwriting", "source": "camera",
  "title": "수학 필기", "description": null,
  "blobUrls": ["<blobUrl>", "..."], "avatarItemId": null }
```

`source`는 `camera` · `gallery` · `file` · `scan` · `live_recording` · `audio_file` 중 하나입니다.

서버(`MaterialsService.register`) 순서:

1. 같은 키로 이미 만든 노트가 있으면 그 결과를 돌려줍니다. 내용이 다르면 409 `IDEMPOTENCY_CONFLICT`입니다.
2. 내 폴더인지 확인합니다(없으면 404).
3. `prepareFiles`로 파일을 확인합니다. 확장자, 파일 수 규칙(PDF 단독 · 녹음 1개), **내 업로드 경로**(`uploads/{종류}/{내 userId}/`), 파일이 실제로 올라와 있는지, 크기를 봅니다.
4. 트랜잭션으로 노트를 `processing: { status: 'queued' }`로 저장합니다.
5. `ai_jobs`에 작업을 넣고 노트에 연결합니다. 한 노트에는 작업을 만드는 요청이 하나만 되도록 표시를 먼저 잡습니다(`CLAIM_TTL_MS` 60초, 못 잡으면 `CLAIM_WAIT_MS` 300ms씩 최대 5번 기다린 뒤 `503 REGISTRATION_IN_PROGRESS`).
6. 응답: `{ "data": { "material": {…}, "job": {…} } }`

- 키가 없으면 작업 등록에 실패했을 때 노트를 지웁니다. 키가 있으면 같은 키로 다시 요청해 이어 갑니다.
- 앱(`registerMaterial`)은 같은 키의 중복 요청을 한 번만 보내고, 결과를 알 수 없는 실패는 `MATERIAL_REGISTRATION_UNCERTAIN`으로 바꿔 "목록에서 확인해 주세요"를 안내합니다.

### ⑥ 진행 확인과 결과

| 방법 | 내용 |
| --- | --- |
| Socket.IO | 앱이 `ai:subscribe { jobId }`를 보내면 `ai:progress`(진행률 · 단계), `ai:done`(끝난 작업)을 받습니다 |
| 폴링 | 앱이 1.5초마다 `GET /api/v1/ai-jobs/:id`로 확인합니다(소켓이 끊겨도 끝나게 하는 안전망) |
| 취소 · 재시도 | `POST /ai-jobs/:id/cancel`, `POST /ai-jobs/:id/retry` |
| 결과 | `succeeded`면 `/result/[id]`로 이동. `GET /materials/:id`가 끝난 작업의 결과를 노트로 옮겨서 줍니다 |
| 원본 받기 | `GET /materials/:id/download-url` → 읽기 SAS 1시간 + 파일 이름 |

---

## 4. 시간 순서 (필기 사진 예)

```
앱                       NestJS                        Azure Blob        FastAPI(ai)       Azure DocInt
│ 사진 고름(형식·크기 확인)
│── POST /uploads/sas ──▶ 검증 + SAS 계산(15분)
│◀─ uploadUrl, blobUrl ──┘
│── PUT uploadUrl ─────────────────────────────────────▶ 저장
│── POST /images/check ─▶ 내 파일인지 확인(getProperties) ──▶
│                         읽기 SAS 발급(15분)
│                         POST /internal/v1/images/check ─────────────▶ 토큰 확인
│                                                                        4개씩 병렬 ──────▶ 읽기(OCR)
│                                                                        verdict 계산 ◀──────┘
│◀─ { data:[{name,verdict}] } ◀── 응답 검증 ◀────────────────────────────┘
│ (사용자가 걸러낸 뒤)
│── POST /materials ───▶ 저장(queued) + ai_jobs 등록 ───────────(ai_jobs 감시)──▶ 처리기가 가져감
│◀─ { material, job } ──┘
│── Socket ai:subscribe ▶
│◀─ ai:progress … ai:done ◀── 처리기가 ai_jobs 갱신
│── GET /materials/:id ▶ 끝난 작업 결과를 노트로 옮김
```

---

## 5. 사진 검사 내부 인증 (`AI_INTERNAL_TOKEN`)

Nest와 FastAPI는 같은 값의 `AI_INTERNAL_TOKEN`을 양쪽 환경 변수에 두고, Nest가 `Authorization: Bearer <값>`으로 보냅니다.
`apps/ai/app/api/v1/images.py`의 `_authorize`가 확인합니다.

| 상황 | 응답 |
| --- | --- |
| AI 서버에 토큰이 설정되지 않음(빈 값) | 503 (빈 토큰이나 임의 토큰을 보내도 통과시키지 않음) |
| 헤더 없음 · `Bearer ` 접두어 없음 · 대소문자 다름 · 값이 다름 · 앞뒤 공백 | 401 |
| **값에 비 ASCII 문자가 있음** | **401** |
| 일치 | 통과 |

비 ASCII 값 처리: 예전에는 `secrets.compare_digest(str, str)`가 비 ASCII 문자열을 받으면 `TypeError`를 내서 **401이 아니라 500**이 났습니다.
지금은 `supplied.isascii()`로 먼저 거르고, 비교는 바이트(`.encode()`)로 합니다. 회귀 테스트는 `apps/ai/tests/api/test_images.py`의 `non_ascii` 테스트입니다.
토큰 비교는 시간차 공격을 막기 위해 계속 `compare_digest`를 씁니다.

---

## 6. 환경 변수

| 변수 | 어디에 | 용도 |
| --- | --- | --- |
| `AZURE_BLOB_CONTAINER` | api | 컨테이너 이름(소문자 · 숫자 · 하이픈 3~63자). 비우면 `raw` |
| `AZURE_STORAGE_CONNECTION_STRING` | api, ai | **AccountKey 방식**(`AccountName` · `AccountKey` 필수). api는 계정 주소를 따로 받지 않고 여기서 읽습니다. `BlobEndpoint`가 있으면 그 주소를 쓰고, http는 로컬 에뮬레이터(`localhost` · `127.0.0.1`)만 받습니다. 비우면 서버는 뜨고 올리기만 503 |
| `AI_INTERNAL_URL` | api | FastAPI(AI App Service) 주소 |
| `AI_INTERNAL_TOKEN` | api, ai | 두 서버 사이 인증 토큰(`openssl rand -hex 32`로 만든 값을 양쪽에 같게) |
| `AZURE_DOCINT_ENDPOINT` · `AZURE_DOCINT_KEY` | ai | Document Intelligence(OCR) |
| `EXPO_PUBLIC_API_URL` | mobile | 앱이 부르는 NestJS 주소(`…/api/v1`) |
| `EXPO_PUBLIC_USE_LOCAL_DATA` | mobile | `true`면 서버 대신 기기 저장 모드(§7 참고) |

비밀값은 Key Vault `kv-notelink-dev`에서 `scripts/env-vault.sh pull api` / `pull ai`로 받습니다(README 5장 "버전 · 보안").

---

## 7. 문제 해결

| 증상 | 원인 | 해결 |
| --- | --- | --- |
| `POST /uploads/sas`가 `503 UPLOAD_UNAVAILABLE` ("지금은 파일을 올릴 수 없어요") | api에 `AZURE_STORAGE_CONNECTION_STRING`이 없음(로컬 `.env`에 빠져 있기 쉬움). 값이 있는데 형식이 틀리면 503이 아니라 서버가 시작할 때 실패함 | 연결 문자열(AccountKey)을 `env-vault.sh pull api`로 받거나 `.env`에 넣는다. 로컬에서는 Azurite 연결 문자열(`BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1`)도 쓸 수 있다 |
| `POST /uploads/sas`가 `400 FILE_NOT_ALLOWED` ("JPG · … 만 올릴 수 있어요" / "…MB 이하만 올릴 수 있어요") | 확장자 · 크기가 `UPLOAD_RULES`와 다름. 신고 사진은 `contentType`이 확장자와 다를 때도 거절함("사진 형식과 확장자가 맞지 않아요") | 파일 이름의 확장자와 크기를 `UPLOAD_RULES`에 맞춘다. 신고 사진은 `contentType`도 확장자의 형식으로 보낸다 |
| `POST /uploads/sas`가 `429 RATE_LIMITED` | 10분 동안 100번 넘게 발급받음 | 응답의 `retryAfterSeconds`만큼 기다린 뒤 다시 요청한다 |
| Blob PUT이 403 | SAS가 만료됨(15분) 또는 업로드를 늦게 시작, 같은 주소로 두 번 올림(덮어쓰기 불가) | 올리기 직전에 SAS를 새로 받는다. 앱은 `HTTP 403`을 `UploadError`로 보여 준다 |
| Blob PUT이 400 · 필수 헤더 오류 | `x-ms-blob-type: BlockBlob` 헤더 누락 | 응답의 `headers`를 그대로 붙인다 |
| 올린 뒤 사진 검사가 400 "사용할 수 없는 사진" | 내 업로드가 아니거나, 파일이 없거나, Content-Type이 확장자와 다름(예: `.jpg`인데 `image/png`로 올림) | PUT에는 응답의 `headers`(`x-ms-blob-type` · `Content-Type`)를 그대로 붙인다. 서버가 `Content-Type`을 확장자의 형식으로 고쳐 줄 수 있으니 요청에 보낸 `contentType`을 다시 쓰지 않는다. 다른 사용자의 `blobUrl`은 거부되는 게 정상 |
| 사진 검사가 `503 AI_UNAVAILABLE` | ① `AI_INTERNAL_URL`/`TOKEN` 미설정 ② AI 서버 다운 · 5xx ③ **90초 제한 초과** ④ 응답의 이름이 요청과 다르거나 모르는 판정 | 설정 확인 → AI 서버 로그 확인. 20장이 느리면 `MAX_WORKERS`를 올릴 수 있는지 OCR 호출 한도를 확인(§8) |
| AI 서버 로그에 401 | 두 서버의 `AI_INTERNAL_TOKEN`이 다름 | 양쪽을 같은 값으로 맞춘다. 앞뒤 공백 · 줄바꿈이 섞이지 않았는지 확인 |
| AI 서버가 사진 검사에서 **500** | (고침) 비 ASCII 헤더가 `compare_digest`에서 `TypeError`를 냄 | §5의 수정 적용. 같은 증상이 남으면 `_authorize` 외의 예외인지 로그 확인 |
| AI 서버 503 "Image check is not configured" | `AZURE_DOCINT_*` 미설정 또는 키 · 권한 오류(401 · 403) | Document Intelligence 엔드포인트 · 키 · 권한 확인 |
| 같은 사진이 계속 `blurry` | 신뢰도 평균이 0.45 미만 | 조명 · 초점을 바꿔 다시 찍는다. 기준 조정은 `image_check.py`의 상수 + 테스트를 함께 바꾼다 |
| `POST /materials`가 400 `FILE_NOT_ALLOWED` | 확장자가 종류와 안 맞음(예: 녹음에 jpg) 또는 크기 초과 | `kind` ↔ 업로드 종류 매핑(§2)을 확인 |
| `POST /materials`가 400 "올린 파일을 찾을 수 없어요" / "사용할 수 없는 파일 주소예요" | ③을 건너뛰었거나, 다른 사용자 · 다른 종류의 경로, SAS가 붙은 주소를 보냄 | `blobUrl`(SAS 없는 주소)만 보낸다 |
| `POST /materials`가 409 `IDEMPOTENCY_CONFLICT` | 같은 `Idempotency-Key`로 다른 내용을 보냄, 또는 그 키로 만든 노트를 지움 | 새 등록이면 키를 새로 만든다 |
| `503 REGISTRATION_IN_PROGRESS` | 같은 노트의 작업을 다른 요청이 만드는 중 | 잠시 뒤 같은 키로 다시 요청 |
| 앱이 "등록 결과를 확인할 수 없어요"(`MATERIAL_REGISTRATION_UNCERTAIN`) | 등록 응답을 받지 못함(네트워크 · 5xx) | 노트 목록을 확인한다. 이미 만들어졌을 수 있어 같은 키로 재시도하면 같은 결과가 돌아온다 |
| 화면은 정상인데 서버 로그에 요청이 없음 | `EXPO_PUBLIC_USE_LOCAL_DATA=true`라 기기 저장 모드(`localApi`)로 동작 중 | 서버 연동을 확인하려면 `false`로 바꾸고 앱을 다시 빌드 |
| 진행률이 안 오름 | 소켓 연결 끊김 | 앱이 1.5초 폴링으로 보완한다. 계속 안 오르면 `ai_jobs` 처리기가 돌고 있는지 확인 |

---

## 8. 알려진 한계 · 확인 필요

- **컨테이너 구조 미확정**: 코드는 컨테이너 하나(`AZURE_BLOB_CONTAINER`)에 경로 접두어로만 나눕니다(`reports/…`, `uploads/…`). 로컬 설정의 컨테이너 이름이 신고용(`studyroom-report`)입니다. 자료용 컨테이너를 따로 둘지 Azure 담당자에게 확인해야 합니다. 분리하면 `BlobStorageService`가 용도별로 컨테이너를 고르도록 고쳐야 합니다.
- **실제 OCR 지연 미측정**: 테스트는 파일당 15초를 가정해 20장을 5묶음(75초)으로 계산합니다. 실제 Azure OCR이 파일 한 장에 몇 초 걸리는지는 실환경에서 재 봐야 합니다. `MAX_WORKERS=4`도 Document Intelligence의 호출 한도를 확인한 값이 아닙니다.
- **내부 오류 형식**: FastAPI(`/internal/v1/...`)의 오류 본문은 FastAPI 기본 형식 `{ "detail": … }`입니다. 앱에는 닿지 않고 Nest가 `{ code: 'AI_UNAVAILABLE', message }`로 바꿔 내보냅니다(README 5장 "오류 `{ code, message }`"는 앱이 보는 API 기준으로 지켜짐).
- 업로드 뒤 사용하지 않은 Blob(사진 검사에서 제외한 사진 등)을 지우는 정리 작업은 이 브랜치에서 확인하지 못했습니다.
- 사진 검사와 노트 등록 사이에 사용자가 파일을 바꾸는 경우는 막지 않습니다. 등록 때 `prepareFiles`가 경로 · 크기만 다시 봅니다.

---

## 9. 테스트

| 대상 | 파일 | 실행 |
| --- | --- | --- |
| SAS 발급 · Blob | `apps/api/test/blob-storage.test.ts` | `cd apps/api && npx vitest run test/blob-storage.test.ts` |
| 사진 검사 API(Nest) | `apps/api/test/images.test.ts` (소유 확인 · 입력 거부 · 90초 만료 · 응답 변조) | `cd apps/api && npx vitest run test/images.test.ts` |
| 사진 검사 판정 | `apps/ai/tests/services/test_image_check.py` (필기 글자 수 3 · 신뢰도 0.45 경계 포함) | `cd apps/ai && python -m pytest tests/services/test_image_check.py` |
| 사진 검사 엔드포인트 · 인증 · 병렬 · 지연 | `apps/ai/tests/api/test_images.py` | `cd apps/ai && python -m pytest tests/api` |

`test_images.py`의 병렬 · 지연 테스트는 실제로 기다리지 않습니다. 가짜 OCR이 시험이 풀어 줄 때까지 멈추고, 풀어 준 묶음 수를 OCR 지연 횟수로 셉니다.
20장은 `ceil(20 / 4) = 5`묶음이어야 하고, 한 파일이 일시 오류로 실패하면 남은 작업을 취소해야 합니다.

---

## 10. README 5장 일치 점검

`feature/FR-19-image-check-api` 기준으로 코드와 README 5장 · `AGENTS.md`의 리뷰 규칙을 대조했습니다.

| 항목 | 결과 |
| --- | --- |
| 주소 `/api/v1/kebab-case` | 일치: `/uploads/sas`, `/images/check`, `/materials`, `/folders/:id/materials`, `/ai-jobs/:id` |
| 응답 `{ data }` | 일치. FastAPI 내부 응답도 `{ "data": [...] }` |
| 오류 `{ code, message }` | 앱이 보는 API는 일치(`HttpExceptionFilter`). FastAPI 내부는 `{ detail }`로 다르지만 Nest가 변환(§8) |
| 이름 규칙 | 일치: `check-images.dto.ts`(kebab-case), Python `snake_case`, 상수 `UPPER_SNAKE`(`MAX_WORKERS`) |
| 시간 | 해당 없음(SAS 만료는 에포크 시간 계산이고 "오늘" 계산이 없음) |
| 비밀값은 서버에만 | 일치. `apps/mobile`에서 `AZURE_*` · `AI_INTERNAL_TOKEN` 검색 결과 없음 |
| 앱은 NestJS만 호출 · 파일은 Blob 직접 · DB는 주소만 · FastAPI는 `ai_jobs`만 | 일치 |
| 패키지 버전 고정 | 이번 변경에서 패키지를 추가하지 않음 |
| 테스트 파일 이름 | 일치: `*.test.ts`, `test_*.py` |
| **README 상단 "현재 상태"** | **불일치**: "기능 코드는 아직 없습니다"라고 적혀 있지만 이 브랜치에는 업로드 · 사진 검사 · 노트 등록이 구현돼 있음. README 문구 갱신이 필요함(이 문서 작업에서는 고치지 않음) |
