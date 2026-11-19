import { act, renderHook } from '@testing-library/react-native';
import { Keyboard, Platform, type View } from 'react-native';
import { carryStudyTime } from '../features/studyroom/room';
import { keyboardOverlap, useKeyboardInset } from '../hooks/keyboard-inset';

// 실기기 테스트: 스터디룸에서 채팅을 치면 입력줄이 키보드에 가려 무엇을 치는지 보이지 않았다
describe('스터디룸 채팅 입력줄 — 키보드만큼 올리기', () => {
  it('화면 아래끝과 키보드 위끝이 겹치는 만큼만 띄운다', () => {
    expect(keyboardOverlap({ y: 0, height: 844 }, 844 - 336)).toBe(336);
    // 화면이 창 맨 위에서 시작하지 않아도(부모 기준이 아니라 창 기준) 정확히 겹친 만큼
    expect(keyboardOverlap({ y: 54, height: 790 }, 844 - 336)).toBe(336);
    // 겹치지 않으면 0
    expect(keyboardOverlap({ y: 0, height: 400 }, 600)).toBe(0);
  });

  it('키보드가 뜨면 창 기준으로 잰 겹친 높이를, 내려가면 0을 돌려준다', async () => {
    const handlers = new Map<string, (e: unknown) => void>();
    const spy = jest.spyOn(Keyboard, 'addListener').mockImplementation(((
      name: string,
      cb: (e: unknown) => void,
    ) => {
      handlers.set(name, cb);
      return { remove: jest.fn() };
    }) as never);
    const node = {
      measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) =>
        cb(0, 0, 390, 844),
    };
    const ref = { current: node as unknown as View };
    const { result } = await renderHook(() => useKeyboardInset(ref));
    const ios = Platform.OS === 'ios';
    await act(async () =>
      handlers.get(ios ? 'keyboardWillShow' : 'keyboardDidShow')!({
        endCoordinates: { screenY: 844 - 336, height: 336, screenX: 0, width: 390 },
      }),
    );
    expect(result.current[0]).toBe(336);
    await act(async () => handlers.get(ios ? 'keyboardWillHide' : 'keyboardDidHide')!({}));
    expect(result.current[0]).toBe(0);
    spy.mockRestore();
  });
});

// 실기기 테스트: 스터디룸에 새 멤버가 들어올 때마다 모두의 공부시간이 0으로 돌아갔다
describe('스터디룸 공부시간 — 멤버 목록을 새로 받아도 이어 간다', () => {
  const member = (userId: string, todaySec?: number) =>
    ({
      userId,
      nickname: userId,
      role: 'member',
      status: 'joined',
      ...(todaySec === undefined ? {} : { todaySec }),
    }) as never;
  const t0 = Date.parse('2026-11-18T03:00:00Z'); // 서울 12:00

  it('서버가 값을 주지 않으면 이전 값 + 흐른 시간을 이어 가고, 새 멤버는 0부터 센다', () => {
    const next = carryStudyTime(
      [member('a', 100), member('b')],
      t0,
      [member('a'), member('b'), member('c')],
      t0 + 60_000,
    );
    expect(next.map((m: { todaySec?: number }) => m.todaySec)).toEqual([160, 60, undefined]);
  });

  it('서버가 값을 주면 그 값을 쓴다', () => {
    const next = carryStudyTime([member('a', 100)], t0, [member('a', 5000)], t0 + 60_000);
    expect((next[0] as { todaySec?: number }).todaySec).toBe(5000);
  });

  it('서울 자정을 넘기면 자정부터 다시 센다', () => {
    const before = Date.parse('2026-11-18T14:59:00Z'); // 서울 23:59
    const after = Date.parse('2026-11-18T15:01:00Z'); // 서울 00:01
    const next = carryStudyTime([member('a', 3600)], before, [member('a')], after);
    expect((next[0] as { todaySec?: number }).todaySec).toBe(60);
  });
});
