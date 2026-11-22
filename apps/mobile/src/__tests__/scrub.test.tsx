import { act, renderHook } from '@testing-library/react-native';
import { scrubTime, useScrub, useScrubState } from '../features/content/scrub';

// 제스처 훅은 받은 설정을 그대로 돌려줘, 시험이 실제 Pan 콜백을 부를 수 있게 한다
jest.mock('react-native-gesture-handler', () => ({
  usePanGesture: (config: unknown) => config,
  useTapGesture: (config: unknown) => config,
  useExclusiveGestures: (pan: unknown, tap: unknown) => ({ pan, tap }),
}));

describe('scrubTime', () => {
  it('가로 위치를 시각으로 바꾸고 바 밖은 0~끝에 고정한다', async () => {
    expect(scrubTime(50, 200, 100)).toBe(25);
    expect(scrubTime(-30, 200, 100)).toBe(0);
    expect(scrubTime(999, 200, 100)).toBe(100);
    expect(scrubTime(10, 0, 100)).toBe(0);
  });
});

describe('useScrubState', () => {
  const setup = async (pos = 10) => {
    const seek = jest.fn();
    const h = await renderHook(({ pos }: { pos: number }) => useScrubState(pos, 100, seek), {
      initialProps: { pos },
    });
    await act(async () => h.result.current.setWidth(200)); // 200px 바, 길이 100초
    return { seek, h };
  };

  it('끄는 동안은 손가락을 따르고 seek는 놓을 때 한 번만 부른다', async () => {
    const { seek, h } = await setup();
    await act(async () => h.result.current.move(40));
    await act(async () => h.result.current.move(120));
    expect(h.result.current.shown).toBe(60);
    expect(h.result.current.dragging).toBe(true);
    expect(seek).not.toHaveBeenCalled();
    await act(async () => h.result.current.end());
    expect(seek).toHaveBeenCalledTimes(1);
    expect(seek).toHaveBeenCalledWith(60);
    expect(h.result.current.dragging).toBe(false);
  });

  it('끄는 중 재생 위치가 들어와도 되돌리지 않고, 놓은 뒤에도 반영될 때까지 놓은 자리를 보여 준다', async () => {
    const { h } = await setup();
    await act(async () => h.result.current.move(120));
    await h.rerender({ pos: 11 });
    expect(h.result.current.shown).toBe(60);
    await act(async () => h.result.current.end());
    await h.rerender({ pos: 11.5 }); // 아직 옛 위치
    expect(h.result.current.shown).toBe(60);
    await h.rerender({ pos: 60.3 }); // 반영됨
    expect(h.result.current.shown).toBe(60.3);
  });

  it('바 밖으로 끌어도 0~끝에 고정한다', async () => {
    const { seek, h } = await setup();
    await act(async () => h.result.current.move(-50));
    expect(h.result.current.shown).toBe(0);
    await act(async () => h.result.current.move(900));
    await act(async () => h.result.current.end());
    expect(seek).toHaveBeenCalledWith(100);
  });

  it('누르기만 해도 그 자리로 한 번 이동하고, 접근성 증감은 5초씩', async () => {
    const { seek, h } = await setup(30);
    await act(async () => h.result.current.tap(50));
    expect(seek).toHaveBeenLastCalledWith(25);
    await act(async () => h.result.current.nudge(5));
    expect(seek).toHaveBeenLastCalledWith(35);
    await act(async () => h.result.current.nudge(-5));
    expect(seek).toHaveBeenLastCalledWith(25);
  });

  it('끌다 취소되면 seek 없이 원래 위치로 돌아온다', async () => {
    const { seek, h } = await setup();
    await act(async () => h.result.current.move(120));
    await act(async () => h.result.current.cancel());
    expect(h.result.current.shown).toBe(10);
    expect(seek).not.toHaveBeenCalled();
  });
});

describe('useScrub 제스처', () => {
  type Pan = {
    activeOffsetX: [number, number];
    failOffsetY: [number, number];
    onActivate: (e: { x: number }) => void;
    onDeactivate: (e: { canceled: boolean }) => void;
    onFinalize: (e: { canceled: boolean }) => void;
  };
  const setup = async () => {
    const seek = jest.fn();
    const h = await renderHook(() => useScrub(10, 100, seek));
    await act(async () => h.result.current.setWidth(200));
    const pan = () => (h.result.current.gesture as unknown as { pan: Pan }).pan;
    return { seek, h, pan };
  };

  it('끌다가 제스처가 취소되면 seek 없이 원위치', async () => {
    const { seek, h, pan } = await setup();
    await act(async () => pan().onActivate({ x: 120 }));
    await act(async () => pan().onDeactivate({ canceled: true }));
    await act(async () => pan().onFinalize({ canceled: true }));
    expect(seek).not.toHaveBeenCalled();
    expect(h.result.current.shown).toBe(10);
  });

  it('정상으로 놓으면 seek 한 번', async () => {
    const { seek, pan } = await setup();
    await act(async () => pan().onActivate({ x: 120 }));
    await act(async () => pan().onDeactivate({ canceled: false }));
    await act(async () => pan().onFinalize({ canceled: false }));
    expect(seek).toHaveBeenCalledTimes(1);
    expect(seek).toHaveBeenCalledWith(60);
  });

  it('가로로 움직일 때만 켜지고 세로 스와이프는 스크롤에 넘긴다', async () => {
    const { pan } = await setup();
    expect(pan().activeOffsetX).toEqual([expect.any(Number), expect.any(Number)]);
    expect(pan().failOffsetY).toEqual([expect.any(Number), expect.any(Number)]);
  });
});
