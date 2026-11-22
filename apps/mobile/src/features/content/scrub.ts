import { useEffect, useRef, useState } from 'react';
import { useExclusiveGestures, usePanGesture, useTapGesture } from 'react-native-gesture-handler';

/** 바 안의 가로 위치(x)를 시각으로. 바 밖으로 끌어도 0~끝에 고정 */
export const scrubTime = (x: number, width: number, duration: number) =>
  width > 0 ? Math.max(0, Math.min(1, x / width)) * duration : 0;

const HOLD_MS = 1000; // 놓은 뒤 옮기기가 반영되길 기다리는 최대 시간
const SETTLED = 1.5; // 이 안으로 오면 반영된 것으로 본다

/**
 * 진행바 끌기 · 누르기. 끄는 동안은 손가락 위치를 보여 주고 seek는 놓을 때 한 번만 부른다.
 * 놓은 직후 아직 옛 위치가 들어와도 손잡이가 되돌아가지 않게, 반영될 때까지 놓은 위치를 보여 준다.
 */
export function useScrubState(pos: number, duration: number, seek: (s: number) => void) {
  const [width, setWidth] = useState(1);
  const [drag, setDrag] = useState<number | null>(null);
  const [held, setHeld] = useState<number | null>(null);
  const at = (x: number) => scrubTime(x, width, duration);
  const release = (t: number) => {
    setDrag(null);
    setHeld(t);
    seek(t);
  };

  // 놓은 자리는 반영될 때(또는 HOLD_MS 뒤)까지만 붙들어 둔다
  useEffect(() => {
    if (held === null) return;
    const id = setTimeout(() => setHeld(null), HOLD_MS);
    return () => clearTimeout(id);
  }, [held]);
  const holding = held !== null && Math.abs(pos - held) >= SETTLED;

  const last = useRef(0);
  return {
    dragging: drag !== null,
    shown: drag ?? (holding ? held : pos),
    setWidth,
    /** 끌기 시작 · 끄는 중: 손가락 위치만 보여 준다 */
    move: (x: number) => setDrag((last.current = at(x))),
    /** 놓기: 마지막 위치로 seek 한 번 */
    end: () => release(last.current),
    cancel: () => setDrag(null),
    /** 누르기: 그 자리로 한 번 */
    tap: (x: number) => release(at(x)),
    nudge: (delta: number) => seek(Math.max(0, Math.min(duration, pos + delta))),
  };
}

/** useScrubState에 손가락 제스처(끌기 + 누르기)를 붙인다 */
export function useScrub(pos: number, duration: number, seek: (s: number) => void) {
  const st = useScrubState(pos, duration, seek);
  const pan = usePanGesture({
    runOnJS: true,
    minDistance: 4,
    onActivate: (e) => st.move(e.x),
    onUpdate: (e) => st.move(e.x),
    onDeactivate: st.end,
    onFinalize: st.cancel,
  });
  const tap = useTapGesture({ runOnJS: true, onActivate: (e) => st.tap(e.x) });
  return { ...st, gesture: useExclusiveGestures(pan, tap) };
}
