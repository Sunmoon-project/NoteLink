import { Easing } from 'react-native-reanimated';

// tokens.js는 tailwind.config.js와 같이 쓰려고 JS로 둔다
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tokens = require('./tokens') as {
  colors: Record<
    | 'canvas'
    | 'fill'
    | 'cream'
    | 'cream-2'
    | 'line'
    | 'brand'
    | 'brand-2'
    | 'mint'
    | 'ink'
    | 'sub'
    | 'night'
    | 'sun'
    | 'sun-ink'
    | 'danger'
    | 'blue'
    | 'orange'
    | 'kakao'
    | 'naver'
    | 'correct'
    | 'correct-soft'
    | 'peach',
    string
  >;
  icon: Record<'xs' | 'sm' | 'md' | 'lg' | 'xl', number>;
  motion: {
    press: { scale: number; damping: number; stiffness: number };
    enter: number;
    exit: number;
    stagger: number;
    ease: [number, number, number, number];
    sheet: [number, number, number, number];
  };
  shadow: { focus: string };
  fontFamily: string;
};

export const C = tokens.colors;
/** 아이콘 크기 — lucide size에 이 값만 쓴다 */
export const ICON = tokens.icon;
export const MOTION = tokens.motion;
/** 모든 timing 모션의 기본 곡선(강한 ease-out). Reanimated withTiming · entering · exiting에 쓴다 */
export const EASE = Easing.bezier(...MOTION.ease);
/** 시트 · 패널이 나갈 때 곡선(iOS 시트). 느리게 출발하는 Easing.in은 쓰지 않는다 */
export const EASE_SHEET = Easing.bezier(...MOTION.sheet);
export const FONT = tokens.fontFamily;
/** 그림자 — style={{ boxShadow: SHADOW.focus }}, 화면마다 하나만 */
export const SHADOW = tokens.shadow;
