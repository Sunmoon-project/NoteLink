import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { RoomScreen } from '../features/studyroom/room';
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
