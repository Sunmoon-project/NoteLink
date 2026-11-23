import { act, fireEvent, screen } from '@testing-library/react-native';
import type { StudyRoom } from '@notelink/shared';
import { router } from 'expo-router';
import { Platform } from 'react-native';
import { RoomListScreen } from '../features/studyroom/room';
import { api, ApiError } from '../lib/api';
import { renderScreen } from '../test-utils';

// 스터디룸 목록 카드의 얼굴은 방 멤버가 아니라 「지금 그 방에 들어와 있는 사람」(rooms:watch · room:live)
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
const mockHandlers = new Map<string, (p: unknown) => void>();
const mockEmit = jest.fn();
jest.mock('../lib/socket', () => ({
  localSocket: { push: jest.fn() },
  socket: {
    emit: (...args: unknown[]) => mockEmit(...args),
    on: (ev: string, fn: (p: unknown) => void) => {
      mockHandlers.set(ev, fn);
      return () => mockHandlers.delete(ev);
    },
    onConnection: (fn: (connected: boolean) => void) => {
      fn(true);
      return () => {};
    },
  },
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('expo-file-system', () => ({ Directory: jest.fn(), File: jest.fn(), Paths: {} }));
jest.mock('expo-calendar', () => ({}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  selectionAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: 'light' },
}));

const member = (userId: string, nickname: string) => ({
  userId,
  nickname,
  role: 'member' as const,
  status: 'joined' as const,
});
const room = {
  _id: 'r1',
  title: '알고리즘 스터디',
  hostId: 'u1',
  inviteCode: 'AB1234',
  members: [member('u1', '발표'), member('u2', '발견'), member('u3', '한결'), member('u4', '두리')],
  memberCount: 4,
  maxCapacity: 6,
} as unknown as StudyRoom;

beforeEach(() => {
  mockHandlers.clear();
  mockEmit.mockReset();
  mockEmit.mockImplementation((ev: string, _p: unknown, ack?: (r: unknown) => void) => {
    if (ev === 'rooms:watch') ack?.({ ok: true, live: { r1: ['u2'] } });
  });
  jest.spyOn(api.rooms, 'mine').mockResolvedValue([room]);
  jest.spyOn(api.rooms, 'recommended').mockResolvedValue([]);
});
afterEach(() => jest.restoreAllMocks());

describe('스터디룸 목록 · 지금 접속 중', () => {
  it('지금 방에 들어와 있는 사람만 얼굴로 보이고, 들어오면 더하고 나가면 바로 뺀다', async () => {
    await renderScreen(<RoomListScreen />);
    await screen.findByText('알고리즘 스터디');
    expect(mockEmit).toHaveBeenCalledWith('rooms:watch', { roomIds: ['r1'] }, expect.any(Function));
    // 멤버는 넷이지만 접속은 한 명 — 멤버 수 문구는 그대로, 접속 수를 따로
    expect(screen.getByText('4명 · 접속 1 · 코드 AB1234')).toBeTruthy();
    expect(screen.getByLabelText('발견')).toBeTruthy();
    expect(screen.queryByLabelText('발표')).toBeNull();

    await act(async () => mockHandlers.get('room:live')?.({ roomId: 'r1', userIds: ['u2', 'u3'] }));
    expect(screen.getByLabelText('한결')).toBeTruthy();
    expect(screen.getByText('4명 · 접속 2 · 코드 AB1234')).toBeTruthy();

    await act(async () => mockHandlers.get('room:live')?.({ roomId: 'r1', userIds: [] }));
    expect(screen.queryByLabelText('발견')).toBeNull();
    expect(screen.queryByLabelText('한결')).toBeNull();
    // 아무도 없으면 접속 수는 빼고 멤버 수만
    expect(screen.getByText('4명 · 코드 AB1234')).toBeTruthy();
  });

  it('이미 들어가 있는 방의 코드를 넣으면 알려 주고 「방으로 가기」로 바로 그 방에 간다', async () => {
    const join = jest.spyOn(api.rooms, 'join');
    await renderScreen(<RoomListScreen />);
    await screen.findByText('알고리즘 스터디');
    await fireEvent.press(screen.getByText('코드로 참여하기'));
    await fireEvent.changeText(screen.getByPlaceholderText('예) AB3F9K'), 'ab1234');
    expect(screen.getByText('이미 들어가 있는 스터디룸이에요')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: '방으로 가기' }));
    expect(join).not.toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledWith({ pathname: '/room/[id]', params: { id: 'r1' } });
  });
  it('코드 입력 칸은 영문 자판으로 뜨고, 참여에 실패하면 이유를 창 안에 보여 준다(토스트는 Modal에 가려진다)', async () => {
    jest
      .spyOn(api.rooms, 'join')
      .mockRejectedValue(new ApiError('ROOM_NOT_FOUND', '스터디룸을 찾을 수 없습니다.', 404));
    await renderScreen(<RoomListScreen />);
    await screen.findByText('알고리즘 스터디');
    await fireEvent.press(screen.getByText('코드로 참여하기'));
    const input = screen.getByPlaceholderText('예) AB3F9K');
    // 한글 자판이면 영문자가 자모(ㅁㅠ…)로 들어와 지워지고 숫자만 남아 「확인」이 켜지지 않는다
    expect(input.props.keyboardType).toBe('ascii-capable');
    await fireEvent.changeText(input, 'zz9999');
    await fireEvent.press(screen.getByRole('button', { name: '확인' }));
    expect(await screen.findByText('스터디룸을 찾을 수 없습니다.')).toBeTruthy();
    // 고쳐 쓰면 지난 오류는 지운다
    await fireEvent.changeText(input, 'zz999');
    expect(screen.queryByText('스터디룸을 찾을 수 없습니다.')).toBeNull();
  });
  it('참여 요청이 진행 중일 때 코드를 고쳐도 추가 참여 요청은 나가지 않는다', async () => {
    const join = jest.spyOn(api.rooms, 'join').mockReturnValue(new Promise(() => {}));
    await renderScreen(<RoomListScreen />);
    await screen.findByText('알고리즘 스터디');
    await fireEvent.press(screen.getByText('코드로 참여하기'));
    const input = screen.getByPlaceholderText('예) AB3F9K');
    await fireEvent.changeText(input, 'zz9999');
    await fireEvent.press(screen.getByRole('button', { name: '확인' }));
    // 응답이 오기 전에 다른 코드로 고쳐도 「확인」은 로딩 그대로여야 한다(reset하면 isPending이 풀려 되살아난다)
    await fireEvent.changeText(input, 'yy8888');
    expect(screen.queryByRole('button', { name: '확인' })).toBeNull();
    expect(join).toHaveBeenCalledTimes(1);
    expect(join).toHaveBeenCalledWith('ZZ9999');
  });
  it('안드로이드에서는 visible-password 자판으로 띄운다', async () => {
    const was = Platform.OS;
    Platform.OS = 'android';
    try {
      await renderScreen(<RoomListScreen />);
      await screen.findByText('알고리즘 스터디');
      await fireEvent.press(screen.getByText('코드로 참여하기'));
      expect(screen.getByPlaceholderText('예) AB3F9K').props.keyboardType).toBe('visible-password');
    } finally {
      Platform.OS = was;
    }
  });
});
