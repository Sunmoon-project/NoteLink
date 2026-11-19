import { forwardRef, type ComponentProps, type ElementRef } from 'react';
import { Pressable as RNPressable, StyleSheet, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { MOTION } from '@/theme';

// 눌림 모션을 더한 Pressable. 기본 Pressable과 쓰는 법이 같아 import만 바꿔 쓴다.
// 줄어드는 상자(Animated.View)가 바깥 배치(여백 · 위치 · flex · 폭)를, 안쪽 Pressable이 모양을 맡는다(공용 Tap과 같은 구조).
// NativeWind className을 Reanimated로 감싼 Pressable에 등록(cssInterop)하면 실제 앱에서 스타일이 빠져 이 구조를 쓴다

const SPRING = { damping: MOTION.press.damping, stiffness: MOTION.press.stiffness };

/** 바깥 상자로 옮길 배치 클래스(여백 · 위치 · 크기 · flex) */
const OUTER =
  /^-?(m[trblxy]?-|flex-1$|flex-\[|basis-|grow|shrink|w-|min-w-|max-w-|self-|absolute$|relative$|inset-|top-|left-|right-|bottom-|z-)/;
export const splitPressClass = (className = '') => {
  const all = className.split(/\s+/).filter(Boolean);
  const outer = all.filter((c) => OUTER.test(c));
  const inner = all.filter((c) => !OUTER.test(c));
  // 바깥이 늘어나거나 가득 채우면 안쪽도 같이 채운다. 안쪽에 flex-1(basis 0)을 주면 높이가 정해지지 않은 바깥(가로 줄의 칸)에서
  // 높이가 0으로 줄어 내용이 잘리므로, 내용 높이는 지키고 남는 만큼만 늘어나는 grow로 채운다(폭은 바깥 폭을 따른다)
  const fills =
    outer.includes('flex-1') || outer.includes('grow') || outer.some((c) => c.startsWith('inset-'));
  if (fills) inner.push('grow');
  return [outer.join(' '), inner.join(' ')] as const;
};

/** 바깥 상자로 옮길 배치 스타일(위치 · 크기 · 여백 · flex). 백분율 left · width가 부모 열 기준으로 계산되게 한다 */
const OUTER_STYLE = new Set<string>([
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'start',
  'end',
  'inset',
  'width',
  'minWidth',
  'maxWidth',
  'height',
  'minHeight',
  'maxHeight',
  'margin',
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
  'marginHorizontal',
  'marginVertical',
  'marginStart',
  'marginEnd',
  'flex',
  'flexGrow',
  'flexShrink',
  'flexBasis',
  'alignSelf',
  'zIndex',
]);
/**
 * style도 className처럼 배치(바깥)와 모양(안쪽)으로 나눈다. 눌림 상태에 따라 바뀌는 함수형 style은 나누지 않는다.
 * 바깥에 높이가 정해지면(height · top과 bottom · flex) 안쪽이 채우도록 grow를 준다
 */
export const splitPressStyle = (style: unknown) => {
  if (!style || typeof style === 'function') return [undefined, style] as const;
  const flat = (StyleSheet.flatten(style as ViewStyle) ?? {}) as Record<string, unknown>;
  const outer: Record<string, unknown> = {};
  const inner: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flat)) (OUTER_STYLE.has(k) ? outer : inner)[k] = v;
  if (!Object.keys(outer).length) return [undefined, style] as const;
  if (
    'height' in outer ||
    'flex' in outer ||
    'flexGrow' in outer ||
    ('top' in outer && 'bottom' in outer)
  )
    inner.flexGrow = 1;
  return [outer as ViewStyle, inner as ViewStyle] as const;
};

type Props = ComponentProps<typeof RNPressable> & {
  className?: string;
  /** 눌렀을 때 크기(기본 MOTION.press.scale). 1이면 줄지 않는다 */
  scaleTo?: number;
};

/**
 * 누르면 살짝(MOTION.press.scale) 작아졌다 돌아온다. 손가락을 대는 순간 줄고(press-in) 떼면 스프링으로 돌아온다.
 * 동작 줄이기 · 1을 주면 · 화면을 덮는 어두운 배경은 감싸지 않고 기본 Pressable 그대로 쓴다(배치도 그대로).
 * 누를 수 없을 때(disabled)는 감싸되 줄지 않는다(상태가 바뀔 때 배치가 흔들리지 않게)
 */
export const Pressable = forwardRef<ElementRef<typeof RNPressable>, Props>(function Pressable(
  {
    className,
    style,
    onPressIn,
    onPressOut,
    disabled,
    scaleTo = MOTION.press.scale,
    hitSlop,
    ...props
  },
  ref,
) {
  const reduce = useReducedMotion();
  const scale = useSharedValue(1);
  const anim = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  if (reduce || scaleTo === 1 || isBackdrop(className))
    return (
      <RNPressable
        ref={ref}
        {...props}
        hitSlop={hitSlop}
        style={style}
        className={className}
        disabled={disabled}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
      />
    );
  const [outer, inner] = splitPressClass(className);
  // className의 absolute를 바깥으로 옮기면 style의 left · width(백분율)도 같은 상자에 있어야 위치가 맞는다(Codex #507 재리뷰)
  const [outerStyle, innerStyle] = splitPressStyle(style);
  return (
    // 바깥 상자에도 같은 hitSlop을 준다. 자식의 터치 확장은 부모 경계 밖에서 잡히지 않아, 감싸면 아이콘 버튼의
    // 터치 영역이 아이콘 크기로 줄었다(Codex #507 재리뷰)
    <Animated.View
      className={outer}
      style={outerStyle ? [outerStyle, anim] : anim}
      hitSlop={hitSlop ?? undefined}
    >
      <RNPressable
        ref={ref}
        {...props}
        hitSlop={hitSlop}
        style={innerStyle as ComponentProps<typeof RNPressable>['style']}
        className={inner}
        disabled={disabled}
        onPressIn={(e) => {
          if (!disabled) scale.set(withSpring(scaleTo, SPRING));
          onPressIn?.(e);
        }}
        onPressOut={(e) => {
          scale.set(withSpring(1, SPRING));
          onPressOut?.(e);
        }}
      />
    </Animated.View>
  );
});

/** 화면을 덮는 누름 영역인지: 가득 채우는 배치(inset-0 · flex-1)에 어두운 막(bg-black/…) */
export const isBackdrop = (className?: string) =>
  !!className &&
  (/\binset-0\b/.test(className) || /\bflex-1\b/.test(className)) &&
  /\bbg-black\//.test(className);
