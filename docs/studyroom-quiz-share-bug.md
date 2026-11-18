# 스터디룸 퀴즈 공유 오류

## 증상과 원인

스터디룸에서 내 퀴즈나 플래시카드를 선택할 수는 있지만 채팅으로 공유할 수 없었다. 기존 화면은 퀴즈를 선택하면 풀이 화면을 열고, 공유 자료 API는 노트만 처리했다.

## 변경 내용

- 스터디룸의 내 퀴즈와 플래시카드 목록에 공유 버튼을 추가한다. 공유가 성공하면 해당 스터디룸 화면으로 돌아간다.
- 서버에서 현재 방 참여 여부와 자료 소유권을 확인한 뒤 기존 `room_shared_items`에 공유 항목을 만들고, 해당 항목을 가리키는 채팅 메시지를 저장한다.
- 방 참가자가 채팅 메시지를 선택하면 현재 참여 여부를 다시 확인한 뒤 공유된 퀴즈나 플래시카드를 보여 준다. 퀴즈는 문제와 정답을 확인하는 읽기 전용 화면이다.
- 노트 공유는 스터디룸 채팅 또는 친구와의 1:1 채팅으로 연결한다. 친구에게 공유한 노트도 현재 채팅 접근 권한을 확인한 뒤 연다.

## 공유 안정성과 권한 검사 보완

- `shareStudyItem()`은 공유 항목과 메시지를 같은 MongoDB 트랜잭션에서 저장한다. 메시지 저장 실패 시 공유 항목도 롤백하고, 커밋 후에만 소켓 알림을 전송한다.
- `Idempotency-Key`를 필수로 받아 방·사용자·요청 ID의 부분 고유 인덱스로 재시도와 동시 요청의 중복 저장을 막는다. 동일 요청은 기존 메시지를 재사용하고, 다른 자료에 같은 ID를 쓰면 409로 거부한다. 누락되거나 잘못된 키는 저장 전에 400으로 거부한다.
- `notifyStudyMessage()`는 전송할 때 토큰과 현재 방 권한을 다시 확인한다. 실제 Socket.IO 연결 테스트로 만료 토큰·강퇴 멤버의 수신 차단과 구독 해제, 다른 방으로의 전달 방지를 검증한다.
- `hasDirectMaterialAccess()`는 `chatRoomId`를 문자열로 바꾼 뒤 `Set`으로 중복 제거한다. 같은 노트를 반복 공유해도 동일 방의 권한은 한 번만 조회하며, 거부된 방 다음의 다른 방은 계속 검사한다.

## 확인한 내용과 한계

- API 테스트는 트랜잭션 실패 전파, 같은 키 재시도·동시 저장 충돌·다른 자료 충돌, 요청 헤더 검증, 소켓 수신 권한, 채팅방 권한 조회 중복 제거를 포함한다.
- 실제 MongoDB의 롤백·동시 요청 검증용 테스트는 `MONGODB_VERIFY_URI`로 실행하며, localhost의 replica set만 허용하고 별도 임시 DB를 사용한다. 주소가 없으면 해당 테스트는 건너뛴다.
- iOS 회귀 테스트는 Release 번들 진입점, Scene 생명주기 등록, 실제 Expo Constants 생성 스크립트의 `notelink` scheme 포함 여부를 검증한다.
- 자동 테스트에는 모의 객체가 포함된다. 실제 두 참가자가 자료를 공유하고 열어 보는 전체 흐름은 별도로 확인해야 한다.

## 남은 확인 및 개선

- 소켓 수신자 조회가 실패해도 공유 요청은 성공할 수 있으므로 실시간 전달 실패와 재접속 후 복구를 확인해야 한다.
- 기존 스터디룸 공유 자료 목록은 현재 노트만 반환한다. 퀴즈와 플래시카드를 그 목록에도 표시할지는 별도 확인이 필요하다.
- 공유 퀴즈를 받은 사용자는 현재 문제와 정답을 볼 수 있지만, 자신의 풀이 기록을 저장하는 기능은 없다.
- 방을 나간 사용자, 다른 방 사용자, 삭제된 원본 자료에 대한 접근과 권한 취소를 실제 DB에서 검증해야 한다.

## 데이터와 배포

기존 `room_shared_items` 컬렉션의 `quizSetId`와 `flashcardIds`를 사용하며 퀴즈 원본은 복사하지 않는다. 원본이 삭제되면 공유 항목도 열 수 없다. 채팅 메시지에는 `sharedItemId`를 저장한다. 로컬 구현은 MongoDB의 `messages`에 1:1 노트 공유 조회용 `sharePreview`를 사용하고 관련 인덱스를 추가한다. 기존 데이터의 일괄 변환은 포함하지 않는다.

트랜잭션을 위해 MongoDB replica set 또는 트랜잭션을 지원하는 클러스터가 필요하다. `room_shared_items`에는 선택 필드 `requestId`와 부분 고유 인덱스를 추가한다.

앱과 API가 함께 변경되므로 공유 기능 테스트 전에 두 변경이 같은 환경에 반영돼야 한다.

## 저장소 루트의 Xcode 프로젝트

`ios/notelink.xcworkspace`의 Release 번들과 Pods 자동 연결은 `apps/mobile`을 앱 루트로 사용한다. `apps/mobile/package.json`의 Expo Router 진입점과 모바일 설정을 기준으로 번들을 만든다. Podfile 변경 후 저장소 루트에서 `pod install --project-directory=ios`를 실행한 뒤 workspace를 열어 Release/Archive한다. 이 변경은 네이티브 전체 빌드나 서명 검증을 대신하지 않는다.

### Release 실행 오류 수정

- `AppDelegate`는 `ExpoReactNativeFactoryProvider`를 구현하고, `Info.plist`의 Scene manifest는 `EXExpoAppSceneDelegate`를 등록한다. 윈도우 생성과 React Native 실행은 Scene delegate가 담당해 Scene 생명주기를 요구하는 SDK의 시작 오류를 방지한다.
- Expo Constants는 JavaScript 번들과 별도의 Pods 빌드 단계에서 설정을 만든다. Podfile의 `post_install`에서 Pods의 `PROJECT_ROOT`도 `apps/mobile`로 지정해 저장소 루트의 불완전한 설정이 앱에 포함되지 않게 한다.
- `Info.plist`의 URL scheme에 `notelink`와 현재 Bundle ID를 등록한다. 모바일 설정과 일치하는 scheme이 Expo Constants에도 포함돼야 Expo Router가 standalone 앱에서 시작된다.
- LiveKitWebRTC 설치를 위해 LiveKit 공식 Pod 저장소와 CocoaPods trunk를 명시한다. Pods 설치 후 lock 파일과 프로젝트의 리소스·프레임워크 연결도 갱신한다.
- 네이티브 설정 변경 후에는 workspace에서 Clean Build Folder를 실행하고 Release로 다시 빌드·설치한다. 자동 검증 통과가 실제 기기 전체 기능 검증을 대신하지는 않는다.

- 루트 Xcode 프로젝트에도 마이크·카메라·사진 보관함·캘린더(기존/전체 접근)의 사용 목적 설명을 포함한다. Expo 설정의 권한 문구만으로 기존 네이티브 프로젝트가 자동 갱신되지는 않으며, 설명 누락 상태에서 권한 API를 사용하면 앱이 종료될 수 있다. 변경 후 실제 기기에서 권한 허용·거부 동작을 확인해야 한다.

### 실제 기기 권한 확인

`ios/notelink/Info.plist`에 `NSCameraUsageDescription`·`NSMicrophoneUsageDescription`을 문자열로 설정한 뒤 루트 workspace의 Release 앱을 다시 설치한다. 아이폰 권한 팝업에서 허용하면 카메라·녹음·스터디룸 캠/마이크를 사용할 수 있으며, 거부 시 앱이 종료되지 않고 접근을 제한하는지 확인한다. 이 키는 `true`로 설정하는 항목이 아니다. 최초 허용·거부 및 스터디룸 동작의 실제 기기 확인 결과는 아직 기록되지 않았다.
