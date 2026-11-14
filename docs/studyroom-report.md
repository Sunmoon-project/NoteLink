# 스터디룸 참가자 신고

로그인한 현재 방 참여자가 같은 방의 다른 현재 참여자를 신고한다. 신고는 `reports`에 접수 상태(`pending`)로 저장하며, 접수만으로 참가자를 강퇴하거나 제재하지 않는다.

## 신고 처리 순서

1. 신고 화면에서 같은 방의 다른 참가자, 신고 유형과 사유를 선택하고 필요한 경우 사진을 첨부한다.
2. 사진이 있으면 앱이 API 서버에 임시 업로드 주소를 요청하고, 응답받은 주소로 사진을 Blob Storage에 직접 업로드한다. 사진이 없으면 이 단계를 건너뛴다.
3. 앱이 방 ID·대상 사용자 ID·유형·사유와 업로드된 사진 주소를 신고 API로 보낸다.
4. 서버는 인증된 신고자와 대상이 해당 방의 현재 참여자인지 확인하고, 사진이 있다면 Blob의 경로와 속성을 확인한 다음 MongoDB에 신고를 저장한다.
5. 신고 저장에 성공한 응답을 받은 뒤 앱이 신고 완료를 표시한다. 사진 업로드만 성공한 상태는 신고 접수가 아니다.

## 신고 접수 API

`POST /api/v1/reports`에 액세스 토큰과 함께 다음 값을 보낸다.

```json
{
  "roomId": "스터디룸 ID",
  "targetUserId": "신고 대상 사용자 ID",
  "reportType": "spam",
  "details": "반복적으로 광고 메시지를 보냅니다",
  "imageUrls": []
}
```

- 유형: `abusive_language`, `spam`, `disturbing`, `obscene`, `other`.
- 신고 내용은 앞뒤 공백을 제거한 뒤 10~500자이며, 첨부 URL은 최대 5개다. 사진 자체가 아니라 HTTP(S) 주소만 저장한다.
- 신고자는 토큰에서 식별한다. 신고자와 대상은 모두 해당 방의 현재 참여자여야 하며, 자신은 신고할 수 없다.
- 성공 시 HTTP 201과 `{ "data": { "_id": "신고 ID", "status": "pending" } }`를 반환한다. 인증 실패는 401, 잘못된 입력은 400, 접근할 수 없는 방이나 대상은 404다.
- 신고 접수는 저장만 담당한다. 신고 검토·처리 API와 관리자용 첨부 조회 API는 별도로 필요하다.
- 신고 내역은 `reports` 컬렉션에 방·신고자·대상 ID, 유형, 사유, 첨부 URL과 상태를 기록한다. 신고 접수는 방 퇴장이나 멤버 제재를 수행하지 않는다.

## 신고 사진 업로드

앱은 먼저 `POST /api/v1/uploads/sas`로 `{ kind: "image", purpose: "report", fileName, contentType, sizeBytes }`를 보내고, 응답의 `uploadUrl`에 `headers`를 사용해 파일을 PUT한다. 업로드가 성공한 뒤 토큰 없는 `blobUrl`을 신고 API의 `imageUrls`로 보낸다. 업로드나 신고 저장 실패 시 입력을 유지하며, 열린 화면에서 재시도하면 이미 업로드한 사진을 재사용한다. 앱을 종료한 후 자동 재전송하는 대기열은 없다.

응답은 `{ data: { uploadUrl, blobUrl, expiresAt, headers } }` 형식이다. 이미지 파일은 JPG·JPEG·PNG·HEIC, 파일당 최대 20MB까지 허용한다. 앱에는 업로드 중·신고 접수 중 상태를 표시하고 전송 중 중복 제출을 막는다.

업로드 주소는 자료 업로드와 같은 `POST /uploads/sas`가 발급한다. 신고 사진도 임시 경로 `incoming/{사용자}/`에 HTTPS 전용·15분 유효·생성 전용 SAS로 올라가고, 사용자당 10분에 100건까지 발급한다. `purpose: "report"`이면 이미지만, 확장자와 같은 형식만 받는다. 신고 접수 시 URL이 신고자의 임시 경로인지 확인하고 Azure에서 Blob의 존재, 크기 및 콘텐츠 유형을 확인한 뒤 `reports/{사용자}/`로 복사하며, 신고에는 복사한 주소를 저장한다. 이 확인은 파일 내용 검사나 악성코드 검사를 대신하지 않는다. 접수하지 않은 사진은 임시 경로의 수명 주기 규칙이 하루 뒤 지운다.

서버에는 `AZURE_STORAGE_CONNECTION_STRING`을 설정하고, 컨테이너는 `AZURE_BLOB_CONTAINER`(비우면 `raw`)로 정한다. 계정 주소는 연결 문자열에서 읽는다. 연결 문자열은 서버의 안전한 환경변수로 제공하고 앱이나 저장소에 넣지 않는다. 배포에서는 Key Vault의 `AZURE-STORAGE-CONNECTION-STRING`을 App Service의 Key Vault 참조로 주입할 수 있다. 이 방식은 스토리지 계정에서 Shared Key 인증을 허용해야 한다.

## 검증과 남은 작업

- 인증·입력·방 참여 권한, 신고 저장과 SAS 범위·사진 경로 검증을 자동화 테스트로 확인한다. 실제 MongoDB 통합 테스트는 `STUDYROOM_TEST_MONGO_URI`가 지정된 로컬 MongoDB에서만 실행한다.
- `AZURE_STORAGE_VERIFY_CONNECTION_STRING`이 있을 때만 도는 `test/upload-real-storage.test.ts`가 실제 저장소에서 신고 사진 업로드, 확인 후 `reports/` 복사(크기·형식 유지)와 다른 사용자 사진 거부를 확인한다. `AZURE_BLOB_INTEGRATION=1`로 실행하는 연결 테스트도 그대로 있다.
- 신고 검토·처리, 비공개 사진의 관리자 열람과 앱 종료 후 자동 재전송은 구현 범위에 포함되지 않는다.
