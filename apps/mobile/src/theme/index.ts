// tokens.js는 tailwind.config.js와 같이 쓰려고 JS로 둔다
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tokens = require('./tokens') as {
  colors: Record<
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
  };
  fontFamily: string;
};

export const C = tokens.colors;
/** 아이콘 크기 — lucide size에 이 값만 쓴다 */
export const ICON = tokens.icon;
export const MOTION = tokens.motion;
export const FONT = tokens.fontFamily;
