import { useEffect, useRef } from 'react';
import { useFrameCallback, useSharedValue, type SharedValue } from 'react-native-reanimated';

/** 마지막으로 받은 재생 상태. at은 받은 시각(ms) */
export type Anchor = { pos: number; at: number; rate: number; playing: boolean };

/** 상태가 이만큼 넘게 안 오면(버퍼링 · 끊김) 더 앞으로 달리지 않는다 */
const MAX_AHEAD_MS = 1000;

/** 마지막 상태에서 지금(now, ms)까지 소리가 나아간 위치(초) */
export function extrapolate(a: Anchor, now: number): number {
  'worklet';
  if (!a.playing) return a.pos;
  const ms = Math.min(Math.max(0, now - a.at), MAX_AHEAD_MS);
  return a.pos + (ms / 1000) * a.rate;
}

/** 기준점 흔들림(상태가 UI에 닿는 시각 차)으로 0.3초 안쪽 뒤로 가면 머문다. 그보다 크면 되감기라 따른다 */
const JITTER_SEC = 0.3;
export function steady(prev: number, next: number, playing: boolean): number {
  'worklet';
  return playing && next < prev && prev - next < JITTER_SEC ? prev : next;
}

/**
 * 재생 위치 시계. expo-audio 상태는 0.25초마다 오므로, 그 사이를 프레임마다 이어 붙여(보간)
 * 자막 채움 · 입 모양이 끊기지 않게 한다. clock은 UI 스레드용, posNow는 JS(아바타 그리기 반복)용.
 * 되감기 · 배속 · 일시정지는 다음 상태에서 바로 다시 고정된다. 멈춰 있으면 프레임 콜백도 쉰다
 */
export function usePlaybackClock(p: { pos: number; playing: boolean; rate: number }): {
  clock: SharedValue<number>;
  posNow: () => number;
} {
  const clock = useSharedValue(p.pos);
  // UI 스레드는 상태를 처음 본 프레임 시각을 기준으로 삼는다(JS와 UI 시계의 기준이 달라도 맞게)
  const anchor = useSharedValue({ pos: p.pos, rate: p.rate, playing: p.playing, seq: 0 });
  const base = useSharedValue({ seq: -1, at: 0 });
  const js = useRef<Anchor>({ pos: p.pos, at: 0, rate: p.rate, playing: p.playing });
  const frames = useFrameCallback(({ timestamp }) => {
    const a = anchor.get();
    if (base.get().seq !== a.seq) base.set({ seq: a.seq, at: timestamp });
    clock.set(steady(clock.get(), extrapolate({ ...a, at: base.get().at }, timestamp), a.playing));
  }, false);
  const seq = useRef(0);
  useEffect(() => {
    js.current = { pos: p.pos, at: performance.now(), rate: p.rate, playing: p.playing };
    anchor.set({ pos: p.pos, rate: p.rate, playing: p.playing, seq: ++seq.current });
    if (!p.playing) clock.set(p.pos); // 멈춘 채 옮기면(되감기 · 북마크) 바로 그 자리
    frames.setActive(p.playing);
  }, [p.pos, p.rate, p.playing]); // eslint-disable-line react-hooks/exhaustive-deps
  return { clock, posNow: () => extrapolate(js.current, performance.now()) };
}
