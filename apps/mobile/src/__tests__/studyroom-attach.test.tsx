import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { RoomScreen, urlExpired } from '../features/studyroom/room';
import { useAuth } from '../stores/auth';
import { useNet } from '../stores/net';
import { useToast } from '../stores/toast';
import { renderScreen, setParams } from '../test-utils';

// 실기기 테스트: 스터디룸 채팅의 + 로 사진 · 파일을 보내고 싶다고 함
const mockApi = {
  rooms: { get: jest.fn(), leave: jest.fn(), chatRoomId: jest.fn(), setTimer: jest.fn() },
  social: { friends: jest.fn(), messages: jest.fn() },
};
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  ApiError: class ApiError extends Error {},
}));
jest.mock('../lib/env', () => ({ env: { localData: false, apiUrl: 'http://api' } }));
jest.mock('../lib/livekit-loader', () => ({
  loadMedia: async () => ({
    connectMedia: async () => ({
      connected: true,
      micOn: false,
      camOn: false,
      hearing: true,
      toggleMic: jest.fn(),
      toggleCam: jest.fn(),
      toggleHearing: jest.fn(),
      close: jest.fn(async () => {}),
      participantState: () => ({ camOn: false, micOn: false }),
      video: () => null,
    }),
  }),
}));
const mockEmit = jest.fn();
jest.mock('../lib/socket', () => ({
  socket: { emit: (...a: unknown[]) => mockEmit(...a), on: jest.fn(() => () => {}) },
}));
const mockUpload = jest.fn();
jest.mock('../lib/upload', () => ({
  ...jest.requireActual('../lib/upload'),
  uploadToBlob: (...a: unknown[]) => mockUpload(...a),
}));
const mockPickImage = jest.fn();
const mockPickDoc = jest.fn();
const mockOpen = jest.fn(async (_url: string) => ({}));
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: (...a: unknown[]) => mockPickImage(...a),
}));
jest.mock('expo-document-picker', () => ({
  getDocumentAsync: (...a: unknown[]) => mockPickDoc(...a),
}));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: (url: string) => mockOpen(url) }));
const mockShare = jest.fn(async (_url: string) => {});
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: (url: string) => mockShare(url),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-file-system', () => ({ File: jest.fn(), UploadType: { BINARY_CONTENT: 0 } }));
jest.mock('expo-calendar', () => ({}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('expo-router', () => ({
  useIsFocused: () => true,
  useFocusEffect: () => {},
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => globalThis.mockParams,
  useSegments: () => [],
  useSitemap: () => null,
}));

const room = {
  hostId: 'me',
  _id: 'room-1',
  title: '첨부 시험방',
  inviteCode: 'AB1234',
  members: [],
  timerRule: null,
};
const client = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30000, gcTime: Infinity } },
  });
type SendPayload = {
  chatRoomId: string;
  clientId: string;
  attachment?: { blobUrl: string; kind: 'image' | 'file'; name: string };
};
/** 서버처럼: 방 참여는 성공, 첨부는 잠깐 읽을 수 있는 주소를 붙여 돌려준다 */
const serverAcks = () =>
  mockEmit.mockImplementation((ev: string, p: SendPayload, ack?: (r: unknown) => void) => {
    if (ev === 'room:join') ack?.({ ok: true });
    if (ev === 'chat:send' && p.attachment)
      ack?.({
        _id: `srv-${p.clientId}`,
        chatRoomId: p.chatRoomId,
        senderId: 'me',
        clientId: p.clientId,
        type: p.attachment.kind,
        text: null,
        sharedItemId: null,
        attachment: {
          kind: p.attachment.kind,
          name: p.attachment.name,
          sizeBytes: 2048,
          url: `${p.attachment.blobUrl}?sig`,
        },
        createdAt: '2026-11-18T00:00:00.000Z',
      });
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.rooms.get.mockResolvedValue(room);
  mockApi.rooms.chatRoomId.mockResolvedValue('chat-1');
  mockApi.social.messages.mockResolvedValue([]);
  useAuth.setState({ userId: 'me' });
  useNet.setState({ state: 'ok' });
  useToast.setState({ msg: null });
  setParams({ id: room._id });
  serverAcks();
});

const openAttach = async () => {
  await renderScreen(<RoomScreen />, client());
  await screen.findByText(room.title);
  await waitFor(() =>
    expect(mockEmit).toHaveBeenCalledWith('room:join', expect.anything(), expect.any(Function)),
  );
  await fireEvent.press(screen.getByLabelText('사진 · 파일 첨부'));
};

it('사진을 고르면 채팅 경로에 올린 뒤 첨부 메시지로 보내고, 사진 말풍선을 누르면 크게 연다', async () => {
  mockPickImage.mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file:///p.jpg', fileName: 'p.jpg', fileSize: 2048 }],
  });
  mockUpload.mockResolvedValue('https://store/raw/chat/image/me/x.jpg');
  await openAttach();
  await fireEvent.press(screen.getByLabelText('사진 보내기'));
  await waitFor(() =>
    expect(mockEmit).toHaveBeenCalledWith(
      'chat:send',
      expect.objectContaining({
        chatRoomId: 'chat-1',
        attachment: {
          blobUrl: 'https://store/raw/chat/image/me/x.jpg',
          kind: 'image',
          name: 'p.jpg',
        },
      }),
      expect.any(Function),
    ),
  );
  // 채팅 첨부 경로로 올린다
  expect(mockUpload).toHaveBeenCalledWith(
    'image',
    expect.objectContaining({ uri: 'file:///p.jpg', name: 'p.jpg' }),
    undefined,
    undefined,
    'chat',
  );
  await fireEvent.press(await screen.findByLabelText('사진 p.jpg 크게 보기'));
  expect(mockOpen).toHaveBeenCalledWith('https://store/raw/chat/image/me/x.jpg?sig');
});

it('PDF 파일은 이름 · 크기를 보이는 말풍선으로 보내고 누르면 연다', async () => {
  mockPickDoc.mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file:///s.pdf', name: '요약.pdf', mimeType: 'application/pdf', size: 2048 }],
  });
  mockUpload.mockResolvedValue('https://store/raw/chat/document/me/y.pdf');
  await openAttach();
  await fireEvent.press(screen.getByLabelText('파일 (PDF) 보내기'));
  expect(mockPickDoc).toHaveBeenCalledWith(expect.objectContaining({ type: 'application/pdf' }));
  await fireEvent.press(await screen.findByLabelText('파일 요약.pdf 열기'));
  expect(mockUpload).toHaveBeenCalledWith(
    'document',
    expect.anything(),
    undefined,
    undefined,
    'chat',
  );
  expect(mockOpen).toHaveBeenCalledWith('https://store/raw/chat/document/me/y.pdf?sig');
  expect(screen.getByText('2KB')).toBeTruthy();
});

it('고르기를 취소하면 아무것도 보내지 않는다', async () => {
  mockPickImage.mockResolvedValue({ canceled: true, assets: [] });
  await openAttach();
  await fireEvent.press(screen.getByLabelText('사진 보내기'));
  await waitFor(() => expect(mockPickImage).toHaveBeenCalled());
  expect(mockUpload).not.toHaveBeenCalled();
  expect(mockEmit).not.toHaveBeenCalledWith('chat:send', expect.anything(), expect.anything());
});

it('올리기가 실패하면 다시 보내기를 보이고, 누르면 다시 올려 보낸다', async () => {
  mockPickImage.mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file:///p.jpg', fileName: 'p.jpg', fileSize: 2048 }],
  });
  mockUpload
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce('https://store/raw/chat/image/me/z.jpg');
  await openAttach();
  await fireEvent.press(screen.getByLabelText('사진 보내기'));
  await fireEvent.press(await screen.findByText('전송하지 못했어요 · 다시 보내기'));
  await waitFor(() =>
    expect(mockEmit).toHaveBeenCalledWith(
      'chat:send',
      expect.objectContaining({
        attachment: expect.objectContaining({ blobUrl: 'https://store/raw/chat/image/me/z.jpg' }),
      }),
      expect.any(Function),
    ),
  );
  expect(mockUpload).toHaveBeenCalledTimes(2);
});

// 앱 전체 부드러운 모션: 새로 보낸 말풍선만 떠오르며 나타나고, 불러온 이전 기록은 움직이지 않는다
it('불러온 이전 기록은 움직이지 않고, 새로 보낸 말풍선만 떠오르며 나타난다', async () => {
  mockApi.social.messages.mockResolvedValue([
    {
      _id: 'old-1',
      chatRoomId: 'chat-1',
      senderId: 'friend',
      senderNickname: '친구',
      type: 'text',
      text: '예전 메시지',
      sharedItemId: null,
      createdAt: '2026-11-17T00:00:00.000Z',
    },
  ]);
  await renderScreen(<RoomScreen />, client());
  await screen.findByText(room.title);
  await waitFor(() =>
    expect(mockEmit).toHaveBeenCalledWith('room:join', expect.anything(), expect.any(Function)),
  );
  await fireEvent(screen.getByPlaceholderText('채팅을 입력해 주세요'), 'focus');
  const bubbleOf = (text: string) => {
    let node = screen.getByText(text).parent;
    // 채팅 목록 전체도 열릴 때 움직이므로(entering) 그 바깥까지는 올라가지 않는다
    while (node && node.props.testID !== 'room-chat' && !('entering' in node.props))
      node = node.parent;
    return node?.props.testID === 'room-chat' ? null : node;
  };
  expect(await screen.findByText('예전 메시지')).toBeTruthy();
  expect(bubbleOf('예전 메시지')?.props.entering).toBeUndefined();
  // 실기기 피드백: 1:1 채팅처럼 스터디룸 말풍선도 길게 눌러 복사할 수 있다
  expect(screen.getByText('예전 메시지').props.selectable).toBe(true);
  await fireEvent.changeText(screen.getByPlaceholderText('채팅을 입력해 주세요'), '새 메시지');
  await fireEvent.press(screen.getByLabelText('전송'));
  expect(bubbleOf('새 메시지')?.props.entering).toBeDefined();
});

// Codex #507 리뷰: 첨부 주소는 1시간 뒤 만료되는데 그대로 열었고, 기록을 다시 읽어도 옛 주소가 새 주소를 덮었다
describe('만료된 첨부 주소', () => {
  const photo = (url: string) => ({
    _id: 'p1',
    chatRoomId: 'chat-1',
    senderId: 'friend',
    senderNickname: '친구',
    type: 'image',
    text: null,
    sharedItemId: null,
    attachment: { kind: 'image', name: 'x.jpg', sizeBytes: 10, url },
    createdAt: '2026-11-17T00:00:00.000Z',
  });
  const old = 'https://store/x.jpg?se=2020-01-01T00%3A00%3A00Z&sig=old';
  const fresh = 'https://store/x.jpg?se=2099-01-01T00%3A00%3A00Z&sig=new';

  it('만료 판정: 주소의 se가 지났거나 1분 안이면 만료, se가 없으면 만료 아님', () => {
    const now = Date.parse('2026-11-18T00:00:00Z');
    expect(urlExpired(old, now)).toBe(true);
    expect(urlExpired(fresh, now)).toBe(false);
    expect(urlExpired('https://store/x.jpg?se=2026-11-18T00%3A00%3A30Z', now)).toBe(true);
    expect(urlExpired('file:///local.jpg', now)).toBe(false);
  });

  it('만료된 사진을 누르면 기록을 다시 읽어 새 주소로 연다', async () => {
    mockApi.social.messages.mockResolvedValueOnce([photo(old)]).mockResolvedValue([photo(fresh)]);
    await renderScreen(<RoomScreen />, client());
    await screen.findByText(room.title);
    await fireEvent(screen.getByPlaceholderText('채팅을 입력해 주세요'), 'focus');
    await fireEvent.press(await screen.findByLabelText('사진 x.jpg 크게 보기'));
    await waitFor(() => expect(mockOpen).toHaveBeenCalledWith(fresh));
    expect(mockOpen).not.toHaveBeenCalledWith(old);
  });

  // Codex #507 재리뷰: 기기 저장 모드의 file:// 첨부를 브라우저로 열어 실패했다(iOS는 http(s)만)
  it('기기에 저장된(file://) 첨부는 브라우저 대신 공유 시트 미리보기로 연다', async () => {
    mockApi.social.messages.mockResolvedValue([photo('file:///local/x.jpg')]);
    await renderScreen(<RoomScreen />, client());
    await screen.findByText(room.title);
    await fireEvent(screen.getByPlaceholderText('채팅을 입력해 주세요'), 'focus');
    await fireEvent.press(await screen.findByLabelText('사진 x.jpg 크게 보기'));
    await waitFor(() => expect(mockShare).toHaveBeenCalledWith('file:///local/x.jpg'));
    expect(mockOpen).not.toHaveBeenCalled();
  });
});
