import { act, fireEvent, screen, within } from '@testing-library/react-native';
import { TimerScreen } from '../features/studyroom/tools';
import { conflictMessage, periodConflicts } from '../features/studyroom/period-conflicts';
import { useAuth } from '../stores/auth';
import { renderScreen, setParams } from '../test-utils';

// TestQA ROOM-013(iOS, #657): 교시제 편집이 방 시간표를 읽지 않아 멤버 수업과 겹쳐도 몰랐다.
// 정책(완우 11/22): 겹치면 경고만 하고 저장은 막지 않는다
const mockApi = { rooms: { get: jest.fn(), schedule: jest.fn(), setTimer: jest.fn() } };
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  ApiError: class ApiError extends Error {},
  NetworkError: class NetworkError extends Error {},
}));
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('../lib/socket', () => ({ socket: { emit: jest.fn(), on: () => () => {} } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-calendar', () => ({}));

const periods = [
  { start: '09:00', end: '09:50', label: '1교시' },
  { start: '10:00', end: '10:50', label: '2교시' },
];
const rule = { enabled: true, type: 'period', focusMin: 50, breakMin: 10, repeat: 4, periods };
const block = (day: number, start: string, end: string, title: string | null = null) => ({
  day,
  start,
  end,
  title,
});
// 민수: 월 · 수 10:30~12:00 수업(2교시와 겹침), 지은: 시간을 숨김, 방장(나): 금 12:00~13:00
const members = [
  { id: 'host', nickname: '방장', emoji: '✏️', blocks: [block(4, '12:00', '13:00', '자료구조')] },
  {
    id: 'u1',
    nickname: '민수',
    emoji: '✏️',
    blocks: [block(0, '10:30', '12:00'), block(2, '10:30', '12:00')],
  },
  { id: 'u2', nickname: '지은', emoji: '✏️', hidden: true, blocks: [] },
];

describe('periodConflicts · conflictMessage', () => {
  it('매일 같은 시각의 교시와 시간이 걸치는 멤버 수업을 요일과 함께 모은다(끝 = 시작은 겹치지 않음)', () => {
    expect(periodConflicts({ start: '10:00', end: '10:50' }, members, 'host')).toEqual([
      { name: '민수', me: false, days: [0, 2] },
    ]);
    expect(periodConflicts({ start: '09:30', end: '10:30' }, members, 'host')).toEqual([]);
    expect(periodConflicts({ start: '09:00', end: '13:00' }, members, 'host')).toEqual([
      { name: '방장', me: true, days: [4] },
      { name: '민수', me: false, days: [0, 2] },
    ]);
  });

  it('시간을 숨긴 멤버 · 멤버별 일정이 없는 예전 서버 응답은 비교하지 않는다', () => {
    const old = [{ nickname: '민수', emoji: '✏️' }];
    expect(periodConflicts({ start: '00:00', end: '23:59' }, old, 'host')).toEqual([]);
    expect(
      periodConflicts(
        { start: '00:00', end: '23:59' },
        [
          {
            id: 'u2',
            nickname: '지은',
            emoji: '✏️',
            hidden: true,
            blocks: [block(0, '10:00', '11:00')],
          },
        ],
        'host',
      ),
    ).toEqual([]);
  });

  it('안내 문구는 이름 · 요일만(수업 제목은 보이지 않음), 내 수업은 「나」로', () => {
    expect(conflictMessage([])).toBeNull();
    expect(conflictMessage([{ name: '민수', me: false, days: [0, 2] }])).toBe(
      '민수님 수업과 겹쳐요 (월 · 수)',
    );
    expect(conflictMessage([{ name: '방장', me: true, days: [4] }])).toBe('내 수업과 겹쳐요 (금)');
    expect(
      conflictMessage([
        { name: '방장', me: true, days: [4] },
        { name: '민수', me: false, days: [0, 2] },
        { name: '지수', me: false, days: [2, 6] },
      ]),
    ).toBe('나 · 민수님 · 지수님 수업과 겹쳐요 (월 · 수 · 금 · 일)');
  });
});

describe('방 시간 규칙 화면', () => {
  beforeEach(() => {
    setParams({ id: 'r1' });
    useAuth.setState({ userId: 'host' });
    mockApi.rooms.get.mockResolvedValue({
      _id: 'r1',
      title: '방',
      hostId: 'host',
      members: [],
      timerRule: rule,
    });
    mockApi.rooms.schedule.mockResolvedValue({ members, grid: [], startHour: 9, matches: [] });
    mockApi.rooms.setTimer.mockReset().mockResolvedValue(undefined);
  });

  it('교시 목록 · 미리보기에 멤버 수업과 겹치는 교시를 보인다(제목 · 숨긴 멤버 시간은 안 보임)', async () => {
    await renderScreen(<TimerScreen />);
    const second = await screen.findByLabelText('2교시 편집');
    expect(await within(second).findByText('민수님 수업과 겹쳐요 (월 · 수)')).toBeTruthy();
    expect(within(screen.getByLabelText('1교시 편집')).queryByText(/겹쳐요/)).toBeNull();
    expect(screen.getByText('1개 교시가 멤버 수업과 겹쳐요 · 저장은 할 수 있어요')).toBeTruthy();
    expect(screen.getByText('시간을 숨긴 1명은 빼고 확인했어요')).toBeTruthy();
    expect(screen.queryByText(/자료구조/)).toBeNull();
  });

  it('교시 편집에서 멤버 수업과 겹치면 경고하지만 적용 · 저장은 된다', async () => {
    await renderScreen(<TimerScreen />);
    await fireEvent.press(await screen.findByLabelText('1교시 편집'));
    await fireEvent.changeText(screen.getByLabelText('교시 시작'), '10:50');
    await fireEvent.changeText(screen.getByLabelText('교시 종료'), '11:40');
    expect(
      screen.getByText('민수님 수업과 겹쳐요 (월 · 수) · 그래도 적용할 수 있어요'),
    ).toBeTruthy();
    await fireEvent.press(screen.getByText('교시 적용'));
    expect(screen.queryByText('교시 편집')).toBeNull();
    await fireEvent.press(screen.getByText('저장하기'));
    expect(mockApi.rooms.setTimer).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({
        periods: [
          { start: '10:00', end: '10:50', label: '2교시' },
          { start: '10:50', end: '11:40', label: '1교시' },
        ],
      }),
    );
  });

  it('적용이 막히는 입력(다른 교시와 겹침)이면 「그래도 적용」 경고 대신 #649 안내 하나만 보인다', async () => {
    await renderScreen(<TimerScreen />);
    await fireEvent.press(await screen.findByLabelText('1교시 편집'));
    // 11:00~11:40: 민수 수업과만 겹친다 → 경고(적용 가능)
    await fireEvent.changeText(screen.getByLabelText('교시 시작'), '11:00');
    await fireEvent.changeText(screen.getByLabelText('교시 종료'), '11:40');
    expect(screen.getByText(/민수님 수업과 겹쳐요 \(월 · 수\) · 그래도/)).toBeTruthy();
    // 10:30~11:40: 2교시와도 겹친다 → 적용이 막히니 「그래도 적용」은 보이지 않는다
    await fireEvent.changeText(screen.getByLabelText('교시 시작'), '10:30');
    expect(screen.queryByText(/그래도 적용할 수 있어요/)).toBeNull();
    await fireEvent.press(screen.getByText('교시 적용'));
    expect(screen.getByText('다른 교시와 시간이 겹치지 않게 입력해 주세요')).toBeTruthy();
    expect(screen.queryByText(/그래도 적용할 수 있어요/)).toBeNull();
  });

  it('비교할 수 있는 수업 시간이 없으면 「겹치는 교시가 없어요」 대신 확인하지 못했다고 알린다', async () => {
    mockApi.rooms.schedule.mockResolvedValue({
      members: [
        { id: 'host', nickname: '방장', emoji: '✏️', blocks: [] },
        { id: 'u1', nickname: '민수', emoji: '✏️', blocks: [] },
      ],
      grid: [],
      startHour: 9,
      matches: [],
    });
    await renderScreen(<TimerScreen />);
    expect(
      await screen.findByText('비교할 수 있는 멤버 수업 시간이 없어 겹치는지 확인하지 못했어요'),
    ).toBeTruthy();
    expect(screen.queryByText('멤버 수업과 겹치는 교시가 없어요')).toBeNull();
  });

  it('모든 멤버가 시간을 숨겼으면 비교하지 못했다고 알리고 숨긴 인원 · 내 숨김을 안내한다', async () => {
    mockApi.rooms.schedule.mockResolvedValue({
      members: [
        { id: 'host', nickname: '방장', emoji: '✏️', hidden: true, blocks: [] },
        { id: 'u1', nickname: '민수', emoji: '✏️', hidden: true, blocks: [] },
      ],
      grid: [],
      startHour: 9,
      matches: [],
    });
    await renderScreen(<TimerScreen />);
    expect(
      await screen.findByText('비교할 수 있는 멤버 수업 시간이 없어 겹치는지 확인하지 못했어요'),
    ).toBeTruthy();
    expect(screen.getByText('시간을 숨긴 1명은 빼고 확인했어요')).toBeTruthy();
    expect(
      screen.getByText('이 방에서 내 수업 시간을 숨겨 내 수업은 확인하지 않았어요'),
    ).toBeTruthy();
    expect(screen.queryByText(/겹쳐요/)).toBeNull();
  });

  it('내가 이 방에서 시간을 숨겼으면 숨긴 인원에 나를 세지 않고 따로 알린다', async () => {
    mockApi.rooms.schedule.mockResolvedValue({
      members: [
        { id: 'host', nickname: '방장', emoji: '✏️', hidden: true, blocks: [] },
        members[1],
      ],
      grid: [],
      startHour: 9,
      matches: [],
    });
    await renderScreen(<TimerScreen />);
    expect(
      await screen.findByText('이 방에서 내 수업 시간을 숨겨 내 수업은 확인하지 않았어요'),
    ).toBeTruthy();
    expect(screen.queryByText(/시간을 숨긴 \d명/)).toBeNull();
  });

  it('방 규칙을 불러오기 전에는 기본 교시에 경고를 띄우지 않는다', async () => {
    let finish: (room: unknown) => void = () => {};
    mockApi.rooms.get.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await renderScreen(<TimerScreen />);
    await screen.findByLabelText('2교시 편집');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockApi.rooms.schedule).toHaveBeenCalled();
    expect(screen.queryByText(/겹쳐요/)).toBeNull();
    // 방 규칙이 오면 그 교시로 비교한다
    await act(async () =>
      finish({ _id: 'r1', title: '방', hostId: 'host', members: [], timerRule: rule }),
    );
    expect(await screen.findByText('민수님 수업과 겹쳐요 (월 · 수)')).toBeTruthy();
  });

  it('방 시간표를 읽지 못하면 경고 없이 지금처럼 편집 · 저장한다', async () => {
    mockApi.rooms.schedule.mockRejectedValue(new Error('down'));
    await renderScreen(<TimerScreen />);
    await screen.findByLabelText('2교시 편집');
    expect(screen.queryByText(/겹쳐요/)).toBeNull();
    await fireEvent.press(screen.getByText('저장하기'));
    expect(mockApi.rooms.setTimer).toHaveBeenCalled();
  });
});
