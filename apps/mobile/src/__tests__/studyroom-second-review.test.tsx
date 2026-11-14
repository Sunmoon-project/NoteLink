import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { RoomScreen } from '../features/studyroom/room';
import { ReportScreen, RoomSettingsScreen } from '../features/studyroom/tools';
import { useAuth } from '../stores/auth';
import { useToast } from '../stores/toast';
import { useNet } from '../stores/net';
import { useMockFlags } from './fixtures/flags';
import { renderScreen, setParams } from '../test-utils';

const mockApi = {
  rooms: { get: jest.fn(), chatRoomId: jest.fn(), report: jest.fn() },
  social: { messages: jest.fn() },
};
const mockUpload = jest.fn();
const mockPicker = jest.fn();
const mockHandlers = new Map<string, (payload: unknown) => void>();
let mockNow = Date.parse('2026-11-01T09:00:00.000Z');
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  ApiError: class ApiError extends Error {},
}));
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('../lib/upload', () => ({ uploadToBlob: (...args: unknown[]) => mockUpload(...args) }));
jest.mock('../lib/livekit', () => ({
  useLiveRoom: () => ({
    connected: false,
    micOn: false,
    camOn: false,
    hearing: false,
    error: null,
    video: () => null,
    toggleMic: jest.fn(),
    toggleCam: jest.fn(),
    toggleHearing: jest.fn(),
    retry: jest.fn(),
  }),
}));
jest.mock('../lib/socket', () => ({
  socket: {
    emit: jest.fn(),
    on: (event: string, handler: (payload: unknown) => void) => {
      mockHandlers.set(event, handler);
      return () => mockHandlers.delete(event);
    },
  },
}));
jest.mock('../hooks', () => ({ ...jest.requireActual('../hooks'), useNow: () => mockNow }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: (...args: unknown[]) => mockPicker(...args),
}));
jest.mock('expo-calendar', () => ({}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));

const timerRule = {
  enabled: true,
  type: 'pomodoro',
  focusMin: 25,
  breakMin: 5,
  repeat: 4,
  periods: [],
};
const room = {
  _id: 'room-1',
  title: '서버 타이머 방',
  inviteCode: 'AB1234',
  timerRule,
  members: [
    { userId: 'me', nickname: '내 계정', camOn: false, micOn: false },
    { userId: 'friend-1', nickname: '신고할 친구', camOn: false, micOn: false },
  ],
};
const clients: QueryClient[] = [];
function client() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30000, gcTime: Infinity } },
  });
  clients.push(qc);
  return qc;
}
beforeEach(() => {
  jest.clearAllMocks();
  mockHandlers.clear();
  mockNow = Date.parse('2026-11-01T09:00:00.000Z');
  mockApi.rooms.get.mockResolvedValue(room);
  mockApi.rooms.chatRoomId.mockResolvedValue('chat-1');
  mockApi.rooms.report.mockResolvedValue(undefined);
  mockApi.social.messages.mockResolvedValue([]);
  mockUpload.mockReset().mockResolvedValue('https://blob.test/evidence.jpg');
  mockPicker.mockResolvedValue({
    canceled: false,
    assets: [
      {
        uri: 'file://evidence.jpg',
        fileName: 'evidence.jpg',
        mimeType: 'image/jpeg',
        fileSize: 10,
      },
    ],
  });
  useAuth.setState({ userId: 'me' });
  useNet.setState({ state: 'ok' });
  useMockFlags.getState().reset();
  useToast.setState({ msg: null });
  setParams({ id: room._id, target: 'friend-1' });
});
afterEach(() => {
  clients.splice(0).forEach((qc) => qc.clear());
});

it('늦게 입장해도 임의 집중 카운트다운을 만들지 않고 서버 종료시각만 유지한다', async () => {
  const qc = client();
  await renderScreen(<RoomScreen />, qc);
  await screen.findByText(room.title);
  expect(screen.queryByText(/^집중 \d{2}:\d{2}$/)).toBeNull();
  await act(async () =>
    mockHandlers.get('room:timer')!({
      roomId: room._id,
      rule: timerRule,
      phase: 'focus',
      endsAt: new Date(mockNow + 180000).toISOString(),
    }),
  );
  expect(screen.getByText('집중 03:00')).toBeTruthy();
  mockApi.rooms.get.mockResolvedValue({ ...room, timerRule: { ...timerRule, focusMin: 45 } });
  await act(async () => {
    await qc.invalidateQueries({ queryKey: ['room', room._id] });
  });
  await waitFor(() => expect(mockApi.rooms.get.mock.calls.length).toBeGreaterThan(1));
  expect(screen.getByText('집중 03:00')).toBeTruthy();
  await act(async () =>
    mockHandlers.get('room:timer')!({
      roomId: 'another-room',
      rule: timerRule,
      phase: 'break',
      endsAt: new Date(mockNow + 60000).toISOString(),
    }),
  );
  expect(screen.getByText('집중 03:00')).toBeTruthy();
});

it('서버 교시제 타이머는 집중이 아닌 교시 단계와 서버 남은 시간을 표시한다', async () => {
  await renderScreen(<RoomScreen />, client());
  await screen.findByText(room.title);
  await act(async () =>
    mockHandlers.get('room:timer')!({
      roomId: room._id,
      rule: { ...timerRule, type: 'period' },
      phase: 'period',
      endsAt: new Date(mockNow + 120000).toISOString(),
    }),
  );
  expect(screen.getByText('교시 02:00')).toBeTruthy();
});

it('저장 API가 없는 방별 알림은 가짜 토글 대신 준비 중으로 표시한다', async () => {
  await renderScreen(<RoomSettingsScreen />, client());
  expect(screen.queryByLabelText('알림')).toBeNull();
  expect(screen.getByText(/알림.*준비 중/)).toBeTruthy();
});

const reportBody = '학습과 무관한 광고 링크를 계속 올립니다';
async function fillReport() {
  await screen.findByText('신고할 친구');
  await fireEvent.press(screen.getByText('신고 유형을 골라 주세요'));
  await fireEvent.press(screen.getByText('스팸 · 광고'));
  await fireEvent.changeText(
    screen.getByPlaceholderText('신고 사유를 자세히 입력해 주세요. (10자 이상)'),
    reportBody,
  );
  await fireEvent.press(screen.getByText('0/5'));
  await screen.findByText('1/5');
}

it('신고는 첨부를 Blob에 올린 URL만 신고 API에 전달하고 성공 후 복귀한다', async () => {
  await renderScreen(<ReportScreen />, client());
  await fillReport();
  await fireEvent.press(screen.getByRole('button', { name: '신고하기' }));
  await screen.findByText('신고 완료');
  expect(mockUpload).toHaveBeenCalledWith(
    'image',
    expect.objectContaining({
      uri: 'file://evidence.jpg',
      name: expect.any(String),
      mimeType: 'image/jpeg',
    }),
    undefined,
    undefined,
    'report',
  );
  expect(mockApi.rooms.report).toHaveBeenCalledWith({
    roomId: room._id,
    targetUserId: 'friend-1',
    reportType: 'spam',
    details: reportBody,
    imageUrls: ['https://blob.test/evidence.jpg'],
  });
  await fireEvent.press(screen.getByText('확인'));
  expect(router.back).toHaveBeenCalledTimes(1);
});

it.each(['upload', 'report'] as const)(
  '신고 %s 실패는 안내하며 입력과 첨부를 유지한다',
  async (step) => {
    if (step === 'upload') mockUpload.mockRejectedValueOnce(new Error('첨부 업로드 실패'));
    else mockApi.rooms.report.mockRejectedValueOnce(new Error('신고 저장 실패'));
    await renderScreen(<ReportScreen />, client());
    await fillReport();
    await fireEvent.press(screen.getByRole('button', { name: '신고하기' }));
    await waitFor(() => expect(mockUpload).toHaveBeenCalled());
    await waitFor(() => expect(useToast.getState().msg).toBeTruthy());
    expect(screen.queryByText('신고 완료')).toBeNull();
    expect(
      screen.getByPlaceholderText('신고 사유를 자세히 입력해 주세요. (10자 이상)').props.value,
    ).toBe(reportBody);
    expect(screen.getByText('스팸 · 광고')).toBeTruthy();
    expect(screen.getByText('1/5')).toBeTruthy();
    expect(router.back).not.toHaveBeenCalled();
    if (step === 'upload') expect(mockApi.rooms.report).not.toHaveBeenCalled();
    else
      expect(mockApi.rooms.report).toHaveBeenCalledWith(
        expect.objectContaining({
          details: reportBody,
          imageUrls: ['https://blob.test/evidence.jpg'],
        }),
      );
  },
);

it('신고 저장에 실패한 뒤 재시도하면 사진을 다시 업로드하지 않고 접수한다', async () => {
  mockApi.rooms.report.mockRejectedValueOnce(new Error('신고 저장 실패'));
  await renderScreen(<ReportScreen />, client());
  await fillReport();
  await fireEvent.press(screen.getByRole('button', { name: '신고하기' }));
  await waitFor(() => expect(useToast.getState().msg).toBeTruthy());
  expect(screen.queryByText('신고 완료')).toBeNull();
  await fireEvent.press(await screen.findByRole('button', { name: '신고하기' }));
  await screen.findByText('신고 완료');
  expect(mockUpload).toHaveBeenCalledTimes(1);
  expect(mockApi.rooms.report).toHaveBeenCalledTimes(2);
});

it('사진 업로드와 신고 저장이 끝날 때까지 접수 완료를 표시하지 않는다', async () => {
  let finishUpload!: (url: string) => void;
  let finishReport!: () => void;
  mockUpload.mockReturnValueOnce(
    new Promise<string>((resolve) => {
      finishUpload = resolve;
    }),
  );
  mockApi.rooms.report.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finishReport = resolve;
    }),
  );
  await renderScreen(<ReportScreen />, client());
  await fillReport();
  await fireEvent.press(screen.getByRole('button', { name: '신고하기' }));
  expect(await screen.findByText('사진 업로드 중…')).toBeTruthy();
  expect(mockApi.rooms.report).not.toHaveBeenCalled();
  expect(screen.queryByText('신고 완료')).toBeNull();
  await act(async () => finishUpload('https://blob.test/evidence.jpg'));
  expect(await screen.findByText('신고 접수 중…')).toBeTruthy();
  expect(screen.queryByText('신고 완료')).toBeNull();
  await act(async () => finishReport());
  expect(await screen.findByText('신고 완료')).toBeTruthy();
});

it('신고 PNG 첨부는 원본 파일명·MIME·크기를 보존하고 Blob URL만 전송한다', async () => {
  mockPicker.mockResolvedValueOnce({
    canceled: false,
    assets: [
      {
        uri: 'file://evidence.png',
        fileName: 'evidence.png',
        mimeType: 'image/png',
        fileSize: 123,
      },
    ],
  });
  mockUpload.mockResolvedValueOnce('https://blob.test/evidence.png');
  await renderScreen(<ReportScreen />, client());
  await fillReport();
  await fireEvent.press(screen.getByRole('button', { name: '신고하기' }));
  await screen.findByText('신고 완료');
  expect(mockUpload).toHaveBeenCalledWith(
    'image',
    expect.objectContaining({
      uri: 'file://evidence.png',
      name: 'evidence.png',
      mimeType: 'image/png',
      size: 123,
    }),
    undefined,
    undefined,
    'report',
  );
  expect(mockApi.rooms.report).toHaveBeenCalledWith({
    roomId: room._id,
    targetUserId: 'friend-1',
    reportType: 'spam',
    details: reportBody,
    imageUrls: ['https://blob.test/evidence.png'],
  });
});
