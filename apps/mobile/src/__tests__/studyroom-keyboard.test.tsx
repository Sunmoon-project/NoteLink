import { act, renderHook } from '@testing-library/react-native';
import { Keyboard, Platform, type View } from 'react-native';
import { keyboardOverlap, useKeyboardInset } from '../features/studyroom/room';

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
    expect(result.current).toBe(336);
    await act(async () => handlers.get(ios ? 'keyboardWillHide' : 'keyboardDidHide')!({}));
    expect(result.current).toBe(0);
    spy.mockRestore();
  });
});
