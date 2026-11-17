import { connectMedia } from '../lib/livekit-native';

const mockToken = jest.fn();
const mockStart = jest.fn();
const mockStop = jest.fn();
const mockEvents = new Map<string, () => void>();
const mockRemoteVolume = jest.fn();
const mockCameraPublication = { track: {}, isMuted: false };
const mockRemote = {
  identity: 'friend-1',
  isMicrophoneEnabled: false,
  isCameraEnabled: false,
  audioTrackPublications: new Map([['audio-1', { audioTrack: { setVolume: mockRemoteVolume } }]]),
  getTrackPublication: jest.fn(() => mockCameraPublication),
};
const mockRoom = {
  state: 'disconnected',
  localParticipant: {
    identity: 'me',
    isMicrophoneEnabled: false,
    isCameraEnabled: false,
    setMicrophoneEnabled: jest.fn(),
    setCameraEnabled: jest.fn(),
    getTrackPublication: jest.fn(() => mockCameraPublication),
  },
  remoteParticipants: new Map([['friend-1', mockRemote]]),
  on: jest.fn((event: string, callback: () => void) => {
    mockEvents.set(event, callback);
  }),
  removeAllListeners: jest.fn(),
  connect: jest.fn(),
  disconnect: jest.fn(),
};
jest.mock('../lib/api', () => ({
  api: { rooms: { livekitToken: (...args: unknown[]) => mockToken(...args) } },
}));
jest.mock(
  '@livekit/react-native',
  () => ({
    AudioSession: { startAudioSession: () => mockStart(), stopAudioSession: () => mockStop() },
    VideoTrack: () => null,
    registerGlobals: jest.fn(),
  }),
  { virtual: true },
);
jest.mock(
  'livekit-client',
  () => ({
    Room: jest.fn(() => mockRoom),
    RoomEvent: {
      TrackSubscribed: 'TrackSubscribed',
      TrackUnsubscribed: 'TrackUnsubscribed',
      TrackPublished: 'TrackPublished',
      TrackUnpublished: 'TrackUnpublished',
      LocalTrackPublished: 'LocalTrackPublished',
      LocalTrackUnpublished: 'LocalTrackUnpublished',
      TrackMuted: 'TrackMuted',
      TrackUnmuted: 'TrackUnmuted',
      ParticipantConnected: 'ParticipantConnected',
      ParticipantDisconnected: 'ParticipantDisconnected',
      Reconnected: 'Reconnected',
      Reconnecting: 'Reconnecting',
      Disconnected: 'Disconnected',
    },
    Track: { Source: { Camera: 'camera' } },
  }),
  { virtual: true },
);

beforeEach(() => {
  jest.clearAllMocks();
  mockEvents.clear();
  mockRoom.remoteParticipants.set('friend-1', mockRemote);
  mockRemote.isCameraEnabled = false;
  mockRemote.isMicrophoneEnabled = false;
  mockToken.mockResolvedValue({ url: 'wss://media.test', token: 'test-token' });
  mockStart.mockResolvedValue(undefined);
  mockStop.mockResolvedValue(undefined);
  mockRoom.state = 'disconnected';
  mockRoom.connect.mockImplementation(async () => {
    mockRoom.state = 'connected';
  });
  mockRoom.disconnect.mockImplementation(async () => {
    mockRoom.state = 'disconnected';
  });
  mockRoom.localParticipant.isMicrophoneEnabled = false;
  mockRoom.localParticipant.isCameraEnabled = false;
  mockRoom.localParticipant.setMicrophoneEnabled.mockImplementation(async (enabled: boolean) => {
    mockRoom.localParticipant.isMicrophoneEnabled = enabled;
  });
  mockRoom.localParticipant.setCameraEnabled.mockImplementation(async (enabled: boolean) => {
    mockRoom.localParticipant.isCameraEnabled = enabled;
  });
  mockCameraPublication.isMuted = false;
});

it('원격 참가자의 켜기·끄기와 퇴장 상태를 LiveKit에서 읽는다', async () => {
  const changed = jest.fn();
  const connection = await connectMedia('room-1', changed);
  expect(connection.participantState('friend-1')).toEqual({ camOn: false, micOn: false });
  mockRemote.isCameraEnabled = true;
  mockRemote.isMicrophoneEnabled = true;
  mockEvents.get('TrackUnmuted')!();
  expect(changed).toHaveBeenCalled();
  expect(connection.participantState('friend-1')).toEqual({ camOn: true, micOn: true });
  mockRemote.isCameraEnabled = false;
  mockEvents.get('TrackMuted')!();
  expect(connection.participantState('friend-1')).toEqual({ camOn: false, micOn: true });
  mockRoom.remoteParticipants.delete('friend-1');
  mockEvents.get('ParticipantDisconnected')!();
  expect(connection.participantState('friend-1')).toEqual({ camOn: false, micOn: false });
  await connection.close();
});

it('재연결 중에는 이전 참가자 미디어 상태를 표시하지 않는다', async () => {
  const changed = jest.fn();
  const connection = await connectMedia('room-1', changed);
  mockRemote.isCameraEnabled = true;
  mockRoom.state = 'reconnecting';
  mockEvents.get('Reconnecting')!();
  expect(changed).toHaveBeenCalled();
  expect(connection.participantState('friend-1')).toEqual({ camOn: false, micOn: false });
  expect(connection.video('friend-1')).toBeNull();
  mockRoom.state = 'connected';
  mockEvents.get('Reconnected')!();
  expect(connection.participantState('friend-1').camOn).toBe(true);
  await connection.close();
});

it('서버 토큰으로 오디오 세션을 시작한 뒤 실제 SDK에 연결한다', async () => {
  const connection = await connectMedia('room-1', jest.fn());
  expect(mockToken).toHaveBeenCalledWith('room-1');
  expect(mockRoom.connect).toHaveBeenCalledWith('wss://media.test', 'test-token');
  expect(mockStart.mock.invocationCallOrder[0]).toBeLessThan(
    mockRoom.connect.mock.invocationCallOrder[0]!,
  );
  expect(connection).toEqual(
    expect.objectContaining({ connected: true, micOn: false, camOn: false, hearing: true }),
  );
  await connection.close();
});

it('마이크와 카메라는 SDK 토글이 성공한 실제 상태를 반환한다', async () => {
  const changed = jest.fn();
  const connection = await connectMedia('room-1', changed);
  await connection.toggleMic();
  await connection.toggleCam();
  expect(mockRoom.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
  expect(mockRoom.localParticipant.setCameraEnabled).toHaveBeenCalledWith(true);
  expect(connection.micOn).toBe(true);
  expect(connection.camOn).toBe(true);
  expect(changed).toHaveBeenCalledTimes(2);
  mockRoom.localParticipant.setCameraEnabled.mockRejectedValueOnce(new Error('카메라 권한 없음'));
  await expect(connection.toggleCam()).rejects.toThrow('카메라 권한 없음');
  expect(connection.camOn).toBe(true);
  await connection.close();
});

it('듣기를 끄면 기존 원격 트랙과 새로 구독한 트랙 모두 음소거한다', async () => {
  const connection = await connectMedia('room-1', jest.fn());
  await connection.toggleHearing();
  expect(connection.hearing).toBe(false);
  expect(mockRemoteVolume).toHaveBeenLastCalledWith(0);
  mockRemoteVolume.mockClear();
  mockEvents.get('TrackSubscribed')!();
  expect(mockRemoteVolume).toHaveBeenLastCalledWith(0);
  await connection.toggleHearing();
  expect(connection.hearing).toBe(true);
  expect(mockRemoteVolume).toHaveBeenLastCalledWith(1);
  await connection.close();
});

it('실제 카메라 트랙만 표시하며 음소거되거나 없는 사용자는 표시하지 않는다', async () => {
  const connection = await connectMedia('room-1', jest.fn());
  expect(connection.video('me')).not.toBeNull();
  expect(connection.video('friend-1')).not.toBeNull();
  expect(connection.video('unknown')).toBeNull();
  mockCameraPublication.isMuted = true;
  expect(connection.video('friend-1')).toBeNull();
  await connection.close();
});

it('중복 종료해도 SDK 연결과 오디오 세션을 한 번만 정리한다', async () => {
  const connection = await connectMedia('room-1', jest.fn());
  await connection.close();
  await connection.close();
  expect(mockRoom.removeAllListeners).toHaveBeenCalledTimes(1);
  expect(mockRoom.disconnect).toHaveBeenCalledTimes(1);
  expect(mockStop).toHaveBeenCalledTimes(1);
  expect(connection.connected).toBe(false);
});

it('SDK 연결에 실패해도 이벤트·연결·오디오 세션을 정리한다', async () => {
  mockRoom.connect.mockRejectedValueOnce(new Error('접속 거절'));
  await expect(connectMedia('room-1', jest.fn())).rejects.toThrow('접속 거절');
  expect(mockRoom.removeAllListeners).toHaveBeenCalledTimes(1);
  expect(mockRoom.disconnect).toHaveBeenCalledTimes(1);
  expect(mockStop).toHaveBeenCalledTimes(1);
});

it('종료 중 SDK 오류가 나도 오디오 세션을 멈춘다', async () => {
  const connection = await connectMedia('room-1', jest.fn());
  mockRoom.disconnect.mockRejectedValueOnce(new Error('연결 종료 오류'));
  await expect(connection.close()).rejects.toThrow('연결 종료 오류');
  expect(mockStop).toHaveBeenCalledTimes(1);
  expect(connection.connected).toBe(false);
});

it('유효하지 않은 토큰 발급 응답으로는 SDK 연결을 시작하지 않는다', async () => {
  mockToken.mockResolvedValue({ url: 'https://api.test', token: '' });
  await expect(connectMedia('room-1', jest.fn())).rejects.toThrow();
  expect(mockStart).not.toHaveBeenCalled();
  expect(mockRoom.connect).not.toHaveBeenCalled();
});

it('접속 실패와 SDK 정리 오류가 겹쳐도 오디오 세션을 멈춘다', async () => {
  mockRoom.connect.mockRejectedValueOnce(new Error('접속 거절'));
  mockRoom.disconnect.mockRejectedValueOnce(new Error('정리 실패'));
  await expect(connectMedia('room-1', jest.fn())).rejects.toThrow();
  expect(mockStop).toHaveBeenCalledTimes(1);
});

it('연결이 겹치면 마지막 연결이 닫힐 때만 오디오 세션을 끈다', async () => {
  mockToken.mockResolvedValue({ token: 't', url: 'wss://live.example' });
  mockStart.mockClear();
  mockStop.mockClear();
  const previous = await connectMedia('room-1', jest.fn());
  const next = await connectMedia('room-1', jest.fn());
  expect(mockStart).toHaveBeenCalledTimes(1);
  await previous.close();
  expect(mockStop).not.toHaveBeenCalled();
  await next.close();
  expect(mockStop).toHaveBeenCalledTimes(1);
});
