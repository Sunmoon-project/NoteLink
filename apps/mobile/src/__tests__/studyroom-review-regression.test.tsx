import { useAuth } from '../stores/auth';
import { useMockFlags } from '../lib/mock/flags';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { QueryClient } from '@tanstack/react-query';
import * as Calendar from 'expo-calendar';
import type { Message } from '@notelink/shared';
import { api } from '../lib/api';
import { RoomCreateScreen, RoomScreen } from '../features/studyroom/room';
import { TimerScreen, ScheduleScreen } from '../features/studyroom/tools';
import { socket, mockServer } from '../lib/socket';
import { useNet } from '../stores/net';
import { renderScreen, setParams } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-file-system', () => ({ UploadType: { BINARY_CONTENT: 0 }, File: jest.fn() }));
jest.mock('expo-calendar', () => ({
  requestCalendarPermissionsAsync: jest.fn(async () => ({ granted: true })),
  createEventInCalendarAsync: jest.fn(async () => ({ action: 'saved' })),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(),
  impactAsync: jest.fn(),
  ImpactFeedbackStyle: {},
}));

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
beforeEach(() => {
  useNet.setState({ state: 'ok' });
  useMockFlags.setState({ roomDisconnect: false, roomKick: false });
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});
it('타이머 활성화만 바꿔도 기존 반복과 교시표를 보존한다', async () => {
  const [brief] = await api.rooms.recommended();
  const full = await api.rooms.get(brief!._id);
  const periods = [{ start: '14:00', end: '14:40', label: '개별 수업' }];
  jest.spyOn(api.rooms, 'get').mockResolvedValue({
    ...full,
    timerRule: { enabled: true, type: 'period', focusMin: 25, breakMin: 5, repeat: 7, periods },
  });
  const save = jest.spyOn(api.rooms, 'setTimer').mockResolvedValue(full);
  setParams({ id: full._id });
  useAuth.setState({ userId: full.hostId });
  await renderScreen(<TimerScreen />, client());
  await waitFor(() => expect(screen.getByLabelText('방 시간 규칙').props.value).toBe(true));
  await fireEvent(screen.getByLabelText('방 시간 규칙'), 'valueChange', false);
  await fireEvent.press(screen.getByText('저장하기'));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      full._id,
      expect.objectContaining({ enabled: false, repeat: 7, periods }),
    ),
  );
});
it.each(['월', '화', '수', '목', '금', '토', '일'])(
  '%s요일 일정을 서울 시각으로 만든다',
  async (day) => {
    const [brief] = await api.rooms.recommended();
    jest.spyOn(api.rooms, 'schedule').mockResolvedValue({
      members: [],
      grid: [],
      startHour: 9,
      matches: [{ day, label: `${day}요일`, start: '09:00', end: '10:00' }],
    });
    setParams({ id: brief!._id });
    await renderScreen(<ScheduleScreen />, client());
    await screen.findByText(brief!.title);
    await waitFor(() => expect(screen.getAllByText(/09:00/).length).toBeGreaterThan(0));
    await fireEvent.press(screen.getByText('캘린더'));
    await waitFor(() => expect(Calendar.createEventInCalendarAsync).toHaveBeenCalled());
    const event = jest.mocked(Calendar.createEventInCalendarAsync).mock.calls[0]![0]!;
    const start = new Date(event.startDate!);
    expect(new Date(start.getTime() + 9 * 3600000).getUTCDay()).toBe(
      ['일', '월', '화', '수', '목', '금', '토'].indexOf(day),
    );
    expect(start.toISOString().slice(11, 16)).toBe('00:00');
  },
);
it('기록을 기다리는 동안 쓴 대기 메시지는 늦은 기록에도 남고 재연결 때 방을 다시 구독한다', async () => {
  const [brief] = await api.rooms.recommended();
  const chatRoomId = await api.rooms.chatRoomId(brief!._id);
  let resolve!: (m: Message[]) => void;
  jest.spyOn(api.social, 'messages').mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const emit = jest.spyOn(socket, 'emit');
  useNet.setState({ state: 'ok' });
  setParams({ id: brief!._id });
  await renderScreen(<RoomScreen />, client());
  await screen.findByText(brief!.title);
  await waitFor(() => expect(resolve).toBeDefined());
  const input = screen.getByPlaceholderText('채팅을 입력해 주세요');
  await fireEvent(input, 'focus');
  await act(async () => useNet.getState().set('unstable'));
  await fireEvent.changeText(input, '기록보다 먼저 쓴 말');
  await fireEvent(input, 'submitEditing');
  await act(async () => resolve([message(chatRoomId, 'late-history', '늦게 조회된 과거 기록')]));
  await screen.findByText('늦게 조회된 과거 기록');
  expect(screen.getByText('기록보다 먼저 쓴 말')).toBeTruthy();
  const joins = emit.mock.calls.filter((c) => c[0] === 'room:join').length;
  await act(async () => useNet.getState().set('ok'));
  await waitFor(() =>
    expect(emit.mock.calls.filter((c) => c[0] === 'room:join').length).toBeGreaterThan(joins),
  );
});

const message = (chatRoomId: string, id: string, text: string): Message => ({
  _id: id,
  chatRoomId,
  senderId: 'friend-review',
  senderNickname: '친구',
  type: 'text',
  text,
  sharedItemId: null,
  createdAt: '2026-10-31T00:00:00.000Z',
});

it('재연결은 방과 기록을 다시 조회하고 소켓 누락 기록을 ID로 한 번만 표시한다', async () => {
  const [brief] = await api.rooms.recommended();
  const full = await api.rooms.get(brief!._id);
  const chatRoomId = await api.rooms.chatRoomId(full._id);
  const existing = message(chatRoomId, 'old-message', '연결 전 대화');
  const missed = message(chatRoomId, 'missed-message', '연결 중 누락된 대화');
  const refreshed = {
    ...full,
    members: full.members.map((m, i) => (i === 0 ? { ...m, nickname: '재조회된 멤버' } : m)),
  };
  const getRoom = jest
    .spyOn(api.rooms, 'get')
    .mockResolvedValueOnce(full)
    .mockResolvedValue(refreshed);
  const getMessages = jest
    .spyOn(api.social, 'messages')
    .mockResolvedValueOnce([existing])
    .mockResolvedValue([existing, missed]);
  const emit = jest.spyOn(socket, 'emit');
  useNet.setState({ state: 'ok' });
  setParams({ id: full._id });
  await renderScreen(<RoomScreen />, client());
  await screen.findByText(full.title);
  await fireEvent(screen.getByPlaceholderText('채팅을 입력해 주세요'), 'focus');
  await screen.findByText(existing.text!);
  const initialJoins = emit.mock.calls.filter((call) => call[0] === 'room:join').length;
  await act(async () => useNet.getState().set('unstable'));
  await act(async () => useNet.getState().set('ok'));
  await waitFor(() => {
    expect(getRoom.mock.calls.length).toBeGreaterThan(1);
    expect(getMessages.mock.calls.length).toBeGreaterThan(1);
    expect(emit.mock.calls.filter((call) => call[0] === 'room:join').length).toBeGreaterThan(
      initialJoins,
    );
  });
  await screen.findByText('재조회된 멤버');
  await screen.findByText(missed.text!);
  const rejoin = emit.mock.calls.filter((call) => call[0] === 'room:join').at(-1)!;
  const acknowledge = rejoin[2] as (response: { ok: boolean; missed: Message[] }) => void;
  await act(async () => {
    acknowledge({ ok: true, missed: [existing, missed, missed] });
    mockServer.push('chat:message', missed);
  });
  expect(screen.getAllByText(existing.text!)).toHaveLength(1);
  expect(screen.getAllByText(missed.text!)).toHaveLength(1);
});

it('오전 9시 그리드를 누르면 유효한 서울 일정으로 추가한다', async () => {
  const [brief] = await api.rooms.recommended();
  setParams({ id: brief!._id });
  const schedule = await api.rooms.schedule(brief!._id);
  jest
    .spyOn(api.rooms, 'schedule')
    .mockResolvedValue({ ...schedule, startHour: 9, grid: [[2, 0, 0, 0, 0, 0, 0]] });
  await renderScreen(<ScheduleScreen />, client());
  await fireEvent.press(await screen.findByLabelText('월 9:00 일정 추가'));
  await waitFor(() => expect(Calendar.createEventInCalendarAsync).toHaveBeenCalled());
  const event = jest.mocked(Calendar.createEventInCalendarAsync).mock.calls[0]![0]!;
  expect(new Date(event.startDate!).toISOString().slice(11, 16)).toBe('00:00');
});
it('자동 퇴장 후 다시 입장하면 방 구독과 기록을 다시 동기화한다', async () => {
  const [brief] = await api.rooms.recommended();
  setParams({ id: brief!._id });
  const join = jest.spyOn(socket, 'emit');
  const messages = jest.spyOn(api.social, 'messages');
  const chatId = await api.rooms.chatRoomId(brief!._id);
  const qc = client();
  await renderScreen(<RoomScreen />, qc);
  await screen.findByText(brief!.title);
  await waitFor(() => expect(qc.getQueryState(['messages', chatId])?.status).toBe('success'));
  const before = messages.mock.calls.length;
  await act(async () => useMockFlags.setState({ roomKick: true }));
  await fireEvent.press(await screen.findByText('다시 입장'));
  await waitFor(() => expect(messages.mock.calls.length).toBeGreaterThan(before));
  expect(join.mock.calls.filter(([event]) => event === 'room:join').length).toBeGreaterThan(1);
});

it('서울 자정 뒤 오늘 시간은 전날 입장 경과 시간을 포함하지 않는다', async () => {
  const before = Date.parse('2026-11-01T14:59:58Z');
  const now = jest.spyOn(Date, 'now').mockReturnValue(before);
  const [brief] = await api.rooms.recommended();
  const room = await api.rooms.get(brief!._id);
  const me = room.members[0]!;
  useAuth.setState({ userId: me.userId });
  jest.spyOn(api.rooms, 'get').mockResolvedValue({ ...room, members: [{ ...me, todaySec: 3600 }] });
  setParams({ id: room._id });
  const ui = await renderScreen(<RoomScreen />, client());
  await screen.findByText(room.title);
  now.mockReturnValue(before + 5000);
  await waitFor(() => expect(screen.getByText('00:00:03')).toBeTruthy(), { timeout: 2500 });
  await ui.unmount();
});

it('방을 만들면 만들기 화면을 닫고 방을 위에 연다 (탭 스택을 갈아 끼우지 않는다)', async () => {
  await renderScreen(<RoomCreateScreen />, client());
  await fireEvent.changeText(screen.getByPlaceholderText('예) 파이썬 기초 스터디'), '토익 스터디');
  const buttons = screen.getAllByText('스터디룸 만들기');
  await fireEvent.press(buttons[buttons.length - 1]!);
  await waitFor(() =>
    expect(router.push).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/room/[id]' })),
  );
  expect(router.back).toHaveBeenCalled();
  expect(jest.mocked(router.back).mock.invocationCallOrder[0]).toBeLessThan(
    jest.mocked(router.push).mock.invocationCallOrder[0]!,
  );
  expect(router.replace).not.toHaveBeenCalled();
});

it('뒤로 갈 화면이 없을 때 방에서 나가면 스터디룸 탭으로 간다', async () => {
  const [brief] = await api.rooms.recommended();
  setParams({ id: brief!._id });
  jest.mocked(router.canGoBack).mockReturnValueOnce(false);
  await renderScreen(<RoomScreen />, client());
  await screen.findByText(brief!.title);
  await fireEvent.press(screen.getByLabelText('나가기'));
  expect(router.replace).toHaveBeenCalledWith('/(tabs)/studyroom');
  expect(router.back).not.toHaveBeenCalled();
});
