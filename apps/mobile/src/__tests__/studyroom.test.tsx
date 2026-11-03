import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { api } from '../lib/api';
import { RoomScreen } from '../features/studyroom/room';
import { ReportScreen, reportReady } from '../features/studyroom/tools';
import { socket } from '../lib/socket';
import { useAuth } from '../stores/auth';
import { useNet } from '../stores/net';
import { renderScreen, setParams } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-file-system', () => ({ UploadType: { BINARY_CONTENT: 0 }, File: jest.fn() }));
jest.mock('expo-calendar', () => ({}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(),
  impactAsync: jest.fn(),
  ImpactFeedbackStyle: {},
}));

// PR #37 리뷰
describe('신고 입력 검증', () => {
  it('대상 · 유형 · 내용 10자 이상을 모두 채워야 보낸다', () => {
    const ok = { target: 'u1', type: 'spam' as const, body: '광고 링크를 계속 올려요' };
    expect(reportReady(ok)).toBe(true);
    expect(reportReady({ ...ok, target: undefined })).toBe(false);
    expect(reportReady({ ...ok, type: null })).toBe(false);
    expect(reportReady({ ...ok, body: '광고해요' })).toBe(false);
  });

  it('신고 대상 후보는 이 방의 다른 멤버뿐이고, 고르기 전에는 보낼 수 없다', async () => {
    const [room] = await api.rooms.recommended();
    const full = await api.rooms.get(room!._id);
    useAuth.setState({ userId: full.members[0]!.userId });
    setParams({ id: room!._id });
    await renderScreen(<ReportScreen />);
    expect(await screen.findByText('신고할 사람을 골라 주세요')).toBeTruthy();
    await fireEvent.press(screen.getByText('신고할 사람을 골라 주세요'));
    expect(await screen.findByText(full.members[1]!.nickname)).toBeTruthy();
    for (const m of full.members.slice(1)) expect(screen.getByText(m.nickname)).toBeTruthy();
    expect(screen.queryByText(full.members[0]!.nickname)).toBeNull();
    expect(screen.queryByText('김민준')).toBeNull();
    expect(screen.getByRole('button', { name: '신고하기' })).toBeDisabled();
  });
});

describe('실제 연결 끊김', () => {
  it('소켓이 끊겼다 돌아오면 끊긴 동안 쓴 메시지를 보낸다', async () => {
    const [room] = await api.rooms.recommended();
    setParams({ id: room!._id });
    const emit = jest.spyOn(socket, 'emit');
    await renderScreen(<RoomScreen />);
    await screen.findByText(room!.title);
    const input = screen.getByPlaceholderText('채팅을 입력하는 중입');
    await fireEvent(input, 'focus');
    // 기록 조회가 늦게 도착해 대기 메시지를 덮어쓰는 경쟁과 구분한다.
    await screen.findByText('다들 얼마정도 푸셨나요?');
    await act(async () => useNet.getState().set('unstable'));
    expect(await screen.findByText('● 연결이 끊겼어요 · 다시 연결 중…')).toBeTruthy();
    // 끊긴 동안 보낸 메시지는 대기열에 둔다
    await fireEvent.changeText(input, '끊긴 동안 쓴 말');
    await fireEvent(input, 'submitEditing');
    expect(emit.mock.calls.some((c) => c[0] === 'chat:send')).toBe(false);
    await act(async () => useNet.getState().set('ok'));
    expect(await screen.findByText('다시 연결됐어요')).toBeTruthy();
    await waitFor(() =>
      expect(emit).toHaveBeenCalledWith(
        'chat:send',
        expect.objectContaining({ text: '끊긴 동안 쓴 말' }),
        expect.any(Function),
      ),
    );
    // 서버 확인 응답이 도착하면 대기 말풍선을 바꿔야 하며, 같은 말을 추가하면 안 된다.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 250)));
    expect(screen.getAllByText('끊긴 동안 쓴 말')).toHaveLength(1);
  }, 20000);
});
