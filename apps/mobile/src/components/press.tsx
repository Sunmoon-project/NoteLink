import { forwardRef, useState, type ComponentProps, type ElementRef } from 'react';
import { Pressable as RNPressable, type PressableStateCallbackType } from 'react-native';
import { cssInterop } from 'nativewind';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { MOTION } from '@/theme';

// 같은 요소에 눌림 모션만 더한 Pressable. 기본 Pressable과 쓰는 법이 같아 import만 바꿔 쓴다.
// Tap과 달리 감싸는 상자를 더하지 않고(배치 · 크기 그대로) 그 요소 자체를 줄인다.
const AnimatedPressable = Animated.createAnimatedComponent(RNPressable);
// 앱에서는 className을 스타일로 바꿔 준다. 시험(jest)은 NativeWind 변환 없이 className을 그대로 읽어 모양을 확인하므로
// 등록하지 않는다(등록하면 className이 지워져 다른 Pressable과 같은 방식으로 확인할 수 없다)
if (process.env.NODE_ENV !== 'test') cssInterop(AnimatedPressable, { className: 'style' });

const SPRING = { damping: MOTION.press.damping, stiffness: MOTION.press.stiffness };

type Props = ComponentProps<typeof RNPressable> & {
  className?: string;
  /** 눌렀을 때 크기(기본 MOTION.press.scale). 1이면 줄지 않는다 */
  scaleTo?: number;
};

/**
 * 누르면 살짝(MOTION.press.scale) 작아졌다 돌아온다. 손가락을 대는 순간 줄고(press-in) 떼면 돌아온다.
 * 자주 누르는 곳이라 눈에 거의 띄지 않을 만큼만 · 손가락을 따라가게 스프링으로.
 * 동작 줄이기를 켜면 · 누를 수 없을 때(disabled)는 줄지 않는다
 */
export const Pressable = forwardRef<ElementRef<typeof RNPressable>, Props>(function Pressable(
  { style, onPressIn, onPressOut, disabled, scaleTo = MOTION.press.scale, ...props },
  ref,
) {
  const reduce = useReducedMotion();
  const scale = useSharedValue(1);
  const anim = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  // style이 함수면(눌림 상태에 따라 다른 모양) 그 상태를 직접 넘긴다
  const [pressed, setPressed] = useState(false);
  const state: PressableStateCallbackType = { pressed, hovered: false };
  const base = typeof style === 'function' ? style(state) : style;
  // 화면을 덮는 배경(시트 · 메뉴 뒤 어두운 막)은 줄이지 않는다 — 화면 전체가 움찔해 보인다
  const backdrop = isBackdrop(props.className);
  const moves = !reduce && !disabled && scaleTo !== 1 && !backdrop;
  return (
    <AnimatedPressable
      ref={ref}
      {...props}
      disabled={disabled}
      style={moves ? [base, anim] : base}
      onPressIn={(e) => {
        if (typeof style === 'function') setPressed(true);
        if (moves) scale.set(withSpring(scaleTo, SPRING));
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        if (typeof style === 'function') setPressed(false);
        if (moves) scale.set(withSpring(1, SPRING));
        onPressOut?.(e);
      }}
    />
  );
});

/** 화면을 덮는 누름 영역인지: 가득 채우는 배치(inset-0 · flex-1)에 어두운 막(bg-black/…) */
export const isBackdrop = (className?: string) =>
  !!className &&
  (/\binset-0\b/.test(className) || /\bflex-1\b/.test(className)) &&
  /\bbg-black\//.test(className);
