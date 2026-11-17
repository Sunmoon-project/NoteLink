import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'react-native-reanimated';

/**
 * 서버 진행률은 단계마다 몇십 %씩 뛰고 그 사이엔 멈춰 있어 원이 뚝뚝 끊겨 보인다. 표시 값만 목표를 부드럽게
 * 따라가게 하고, 값을 기다리는 동안에는 아주 천천히 조금(목표 + CREEP_MAX%까지) 차오르게 한다.
 * 목표가 줄면(다시 시도) 바로 맞춘다. 동작 줄이기를 켜면 애니메이션 없이 서버 값을 그대로 보인다.
 * 이 컴포넌트만 매 프레임 다시 그려 화면 전체를 다시 그리지 않는다
 */
const CREEP_MAX = 4;
export function useSmoothProgress(target: number): number {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(target);
  const cur = useRef(target);
  useEffect(() => {
    if (reduce) return;
    let raf = 0;
    let last = Date.now();
    const tick = () => {
      const now = Date.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const c = cur.current;
      let next: number;
      if (target < c - 0.5) next = target;
      else if (target - c > 0.3) next = c + (target - c) * Math.min(1, dt * 5);
      else if (target > 0 && target < 100) next = Math.min(c + dt * 0.5, target + CREEP_MAX, 99);
      else next = target;
      if (next !== c) {
        cur.current = next;
        setShown(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, reduce]);
  return reduce ? target : shown;
}
