import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { ChatScreen } from '../features/social/screens';
import { useAuth } from '../stores/auth';
import { renderScreen, setParams } from '../test-utils';

// 1:1 채팅에도 사진 · 문서를 보내고(FR-16-03), 맨 위에 상대 아바타 · 이름 · 지금 상태와 메뉴를 둔다(FR-16-01) — #554 PR 3
const mockApi = {
  rooms: { join: jest.fn() },
  social: { openDirect: jest.fn(), messages: jest.fn(), friends: jest.fn(), remove: jest.fn() },
};
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  ApiError: jest.requireActual('../lib/api/http').ApiError,
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
const mockEmit = jest.fn();
jest.mock('../lib/socket', () => ({
  socket: { on: jest.fn(() => () => {}), emit: (...a: unknown[]) => mockEmit(...a) },
}));
const mockUpload = jest.fn();
jest.mock('../lib/upload', () => ({
  ...jest.requireActual('../lib/upload'),
  uploadToBlob: (...a: unknown[]) => mockUpload(...a),
}));
const mockPickImage = jest.fn();
const mockPickDoc = jest.fn();
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: (...a: unknown[]) => mockPickImage(...a),
}));
jest.mock('expo-document-picker', () => ({
  getDocumentAsync: (...a: unknown[]) => mockPickDoc(...a),
}));
const mockOpen = jest.fn(async (_url: string) => ({}));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: (url: string) => mockOpen(url) }));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));
jest.mock('expo-file-system', () => ({ File: jest.fn(), UploadType: { BINARY_CONTENT: 0 } }));

const fileMessage = {
  _id: 'm-file',
  chatRoomId: 'room1',
  senderId: 'u1',
  type: 'file' as const,
  text: null,
  attachment: { kind: 'file', name: '기출.pdf', sizeBytes: 2048, url: 'https://blob/x.pdf' },
  sharedItemId: null,
  createdAt: '2026-11-19T01:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  useAuth.setState({ userId: 'me' });
  setParams({ id: 'u1', name: '지우', status: 'offline' });
  mockApi.social.openDirect.mockResolvedValue({ _id: 'room1' });
  mockApi.social.messages.mockResolvedValue([]);
  mockApi.social.friends.mockResolvedValue([
    { _id: 'f1', userId: 'u1', nickname: '지우', status: 'active', avatarUrl: null },
  ]);
  // chat:join 응답 · chat:send 응답(첨부 메시지)
  mockEmit.mockImplementation((event: string, data: Record<string, unknown>, ack?: Function) => {
    if (event === 'chat:join') ack?.({ ok: true });
    if (event === 'chat:send' && data.attachment) {
      const a = data.attachment as { kind: string; name: string };
      ack?.({
        _id: 'srv-1',
        clientId: data.clientId,
        chatRoomId: 'room1',
        senderId: 'me',
        type: a.kind,
        text: null,
        attachment: { kind: a.kind, name: a.name, sizeBytes: 10, url: 'https://blob/signed.jpg' },
        sharedItemId: null,
        createdAt: '2026-11-19T02:00:00.000Z',
      });
    }
  });
  mockUpload.mockResolvedValue('https://blob/chat/me/a.jpg');
});

it('헤더는 친구 목록의 지금 상태를 보여 준다(들어올 때 넘긴 값이 아니라)', async () => {
  await renderScreen(<ChatScreen />);
  expect(await screen.findByText('활동 중')).toBeTruthy();
  expect(screen.queryByText('오프라인')).toBeNull();
});

it('+ → 사진을 고르면 채팅 경로에 올린 뒤 첨부 메시지로 보낸다', async () => {
  mockPickImage.mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file:///p.jpg', fileName: 'p.jpg', fileSize: 10 }],
  });
  await renderScreen(<ChatScreen />);
  await waitFor(() => expect(mockApi.social.messages).toHaveBeenCalled());
  await fireEvent.press(screen.getByLabelText('첨부'));
  await fireEvent.press(await screen.findByLabelText('사진 보내기'));
  await waitFor(() =>
    expect(mockEmit).toHaveBeenCalledWith(
      'chat:send',
      expect.objectContaining({
        chatRoomId: 'room1',
        attachment: { blobUrl: 'https://blob/chat/me/a.jpg', kind: 'image', name: 'p.jpg' },
      }),
      expect.any(Function),
    ),
  );
  expect(mockUpload).toHaveBeenCalledWith(
    'image',
    expect.objectContaining({ name: 'p.jpg' }),
    undefined,
    undefined,
    'chat',
  );
  expect(await screen.findByLabelText('사진 p.jpg 크게 보기')).toBeTruthy();
});

it('받은 파일 말풍선을 누르면 연다', async () => {
  mockApi.social.messages.mockResolvedValue([fileMessage]);
  await renderScreen(<ChatScreen />);
  await fireEvent.press(await screen.findByLabelText('파일 기출.pdf 열기'));
  await waitFor(() => expect(mockOpen).toHaveBeenCalledWith('https://blob/x.pdf'));
});

it('메뉴 「주고받은 자료」에서 이 대화의 사진 · 파일을 모아 보여 준다', async () => {
  mockApi.social.messages.mockResolvedValue([fileMessage]);
  await renderScreen(<ChatScreen />);
  await screen.findByLabelText('파일 기출.pdf 열기');
  await fireEvent.press(screen.getByLabelText('더보기'));
  await fireEvent.press(await screen.findByText('주고받은 자료'));
  // 말풍선 하나 + 모아 보기 줄 하나
  await waitFor(() => expect(screen.getAllByText('기출.pdf')).toHaveLength(2));
  expect(screen.getByText(/지우 · 11\/19/)).toBeTruthy();
});

it('서버 방송이 응답보다 먼저 와도 보내는 중 말풍선이 하나로 바뀐다', async () => {
  mockPickImage.mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file:///p.jpg', fileName: 'p.jpg', fileSize: 10 }],
  });
  const handlers = new Map<string, (m: unknown) => void>();
  const { socket } = jest.requireMock('../lib/socket');
  socket.on.mockImplementation((event: string, handler: (m: unknown) => void) => {
    handlers.set(event, handler);
    return () => handlers.delete(event);
  });
  const base = mockEmit.getMockImplementation()!;
  mockEmit.mockImplementation((event: string, data: Record<string, unknown>, ack?: Function) =>
    base(event, data, (sent: unknown) => {
      // 같은 메시지가 방송으로 먼저 오고, 그 뒤에 응답이 온다
      if (event === 'chat:send') handlers.get('chat:message')?.(sent);
      ack?.(sent);
    }),
  );
  await renderScreen(<ChatScreen />);
  await waitFor(() => expect(mockApi.social.messages).toHaveBeenCalled());
  await fireEvent.press(screen.getByLabelText('첨부'));
  await fireEvent.press(await screen.findByLabelText('사진 보내기'));
  await waitFor(() => expect(screen.getAllByLabelText('사진 p.jpg 크게 보기')).toHaveLength(1));
});

it('올리기가 실패하면 다시 보내기를 보이고, 누르면 다시 올려 보낸다', async () => {
  mockPickDoc.mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file:///a.pdf', name: 'a.pdf', mimeType: 'application/pdf', size: 10 }],
  });
  mockUpload.mockRejectedValueOnce(new Error('network'));
  await renderScreen(<ChatScreen />);
  await waitFor(() => expect(mockApi.social.messages).toHaveBeenCalled());
  await fireEvent.press(screen.getByLabelText('첨부'));
  await fireEvent.press(await screen.findByLabelText('파일 (PDF) 보내기'));
  await fireEvent.press(await screen.findByText('전송하지 못했어요 · 다시 보내기'));
  await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText('전송하지 못했어요 · 다시 보내기')).toBeNull());
  expect(screen.getAllByLabelText('파일 a.pdf 열기')).toHaveLength(1);
});

it('주고받은 자료에는 보내는 중 · 실패한 말풍선(기기 파일)을 넣지 않는다', async () => {
  mockPickDoc.mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file:///a.pdf', name: 'a.pdf', mimeType: 'application/pdf', size: 10 }],
  });
  mockUpload.mockRejectedValueOnce(new Error('network'));
  await renderScreen(<ChatScreen />);
  await waitFor(() => expect(mockApi.social.messages).toHaveBeenCalled());
  await fireEvent.press(screen.getByLabelText('첨부'));
  await fireEvent.press(await screen.findByLabelText('파일 (PDF) 보내기'));
  await screen.findByText('전송하지 못했어요 · 다시 보내기');
  await fireEvent.press(screen.getByLabelText('주고받은 자료'));
  expect(await screen.findByText('아직 주고받은 사진 · 파일이 없어요')).toBeTruthy();
});

it('응답 시간이 지나 실패로 바뀐 뒤 서버가 저장한 메시지가 늦게 오면 실패 표시 없이 하나만 남는다', async () => {
  jest.useFakeTimers();
  mockPickDoc.mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file:///a.pdf', name: 'a.pdf', mimeType: 'application/pdf', size: 10 }],
  });
  const handlers = new Map<string, (m: unknown) => void>();
  const { socket } = jest.requireMock('../lib/socket');
  socket.on.mockImplementation((event: string, handler: (m: unknown) => void) => {
    handlers.set(event, handler);
    return () => handlers.delete(event);
  });
  // 서버는 저장했지만 응답이 오지 않는다
  let sent: Record<string, unknown> | undefined;
  const base = mockEmit.getMockImplementation()!;
  mockEmit.mockImplementation((event: string, data: Record<string, unknown>, ack?: Function) =>
    event === 'chat:send' ? (sent = data) : base(event, data, ack),
  );
  try {
    await renderScreen(<ChatScreen />);
    await waitFor(() => expect(mockApi.social.messages).toHaveBeenCalled());
    await fireEvent.press(screen.getByLabelText('첨부'));
    await fireEvent.press(await screen.findByLabelText('파일 (PDF) 보내기'));
    await waitFor(() => expect(sent).toBeDefined());
    await act(() => jest.advanceTimersByTime(8_000));
    await screen.findByText('전송하지 못했어요 · 다시 보내기');
    // 늦게 온 방송(같은 clientId) → 실패 표시가 사라지고 말풍선은 하나
    await act(() =>
      handlers.get('chat:message')?.({
        _id: 'srv-late',
        clientId: sent!.clientId,
        chatRoomId: 'room1',
        senderId: 'me',
        type: 'file',
        text: null,
        attachment: { kind: 'file', name: 'a.pdf', sizeBytes: 10, url: 'https://blob/signed.pdf' },
        sharedItemId: null,
        createdAt: '2026-11-19T02:00:00.000Z',
      }),
    );
    expect(screen.queryByText('전송하지 못했어요 · 다시 보내기')).toBeNull();
    expect(screen.getAllByLabelText('파일 a.pdf 열기')).toHaveLength(1);
  } finally {
    jest.useRealTimers();
  }
});
