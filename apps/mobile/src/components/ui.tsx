import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  View,
  type ScrollViewProps,
  type TextInputProps,
} from 'react-native';
import { Text, TextInput } from './text';
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  FadeOut,
  LinearTransition,
  SlideInDown,
  SlideOutDown,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path, SvgXml } from 'react-native-svg';
import { router, useSegments } from 'expo-router';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  type LucideIcon,
  Search as SearchIcon,
  X,
} from 'lucide-react-native';
import { C, ICON, MOTION } from '@/theme';

// 공통 UI. 웹 프로토타입(ui.tsx)과 같은 이름 · 같은 모양으로 맞췄다.

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ── 면 ───────────────────────────────────────────────
// 같은 카드 · 칩 · 입력도 놓인 면에 따라 바탕색이 다르다 (DESIGN.md 색 · 면).
// canvas: 회색 화면 바탕 → 그 위는 흰 카드 · 흰 칩
// white: 흰 카드 · 시트 · 다이얼로그 안 → 채움(fill) 바탕
// legacy: 아직 개편 전 흰 화면 → 이전처럼 크림 (화면 PR에서 Screen canvas로 옮기면 사라진다)
type Surface = 'canvas' | 'white' | 'legacy';
const SurfaceCtx = createContext<Surface>('legacy');
export const useSurface = () => useContext(SurfaceCtx);
/** 면에 놓인 카드 · 칩 · 입력의 바탕 */
const FILL: Record<Surface, string> = { canvas: 'bg-white', white: 'bg-fill', legacy: 'bg-cream' };
/**
 * 개편된 화면의 바깥 틀: 회색 바탕 + 그 안 전부(Screen 밖에 붙는 Sheet · Dialog 포함)를 캔버스 면으로.
 * 시트를 Screen 밖에 두는 화면은 Screen canvas 대신 이것으로 감싼다
 */
export const Canvas = ({ children, cream }: { children: ReactNode; cream?: boolean }) => (
  <SurfaceCtx.Provider value="canvas">
    {/* cream: 온보딩 · 로그인처럼 브랜드 인상을 남기는 화면 (그 위 칸 · 버튼은 캔버스와 같은 흰색) */}
    <View className={cx('flex-1', cream ? 'bg-cream' : 'bg-canvas')}>{children}</View>
  </SurfaceCtx.Provider>
);
/** 흰 면(카드 · 시트) 안의 내용 — 칩 · 입력이 채움 바탕이 된다. 개편 전 화면에서는 그대로 둔다 */
export const OnWhite = ({ children }: { children: ReactNode }) => {
  const surface = useSurface();
  if (surface === 'legacy') return <>{children}</>;
  return <SurfaceCtx.Provider value="white">{children}</SurfaceCtx.Provider>;
};

// ── 모션 ─────────────────────────────────────────────
// 모든 움직임은 MOTION 토큰을 쓴다. Reanimated는 기본으로 시스템의 '동작 줄이기'를 따른다.

const PRESS = { damping: MOTION.press.damping, stiffness: MOTION.press.stiffness };

// 바깥(스케일이 걸리는 상자)에 둘 클래스: 위치 · 바깥 여백 · 너비 · 늘어남. 나머지는 안쪽 Pressable에 둔다
const OUTER =
  /^-?(m[trblxy]?-|flex-1$|flex-\[|basis-|grow|shrink|w-|min-w-|max-w-|self-|absolute$|relative$|inset-|top-|left-|right-|bottom-|z-)/;
const splitClass = (className = '') => {
  const all = className.split(/\s+/).filter(Boolean);
  const outer = all.filter((c) => OUTER.test(c));
  const inner = all.filter((c) => !OUTER.test(c));
  // 바깥이 늘어나면 안쪽도 같이 채운다
  if (outer.includes('flex-1')) inner.push('flex-1');
  return [outer.join(' '), inner.join(' ')] as const;
};

/** 누르면 살짝 작아졌다 돌아오는 Pressable (버튼 · 카드 · 칩 공통 눌림 피드백) */
export function Tap({
  scaleTo = MOTION.press.scale,
  className,
  onPressIn,
  onPressOut,
  style,
  ...props
}: ComponentProps<typeof Pressable> & { scaleTo?: number; className?: string }) {
  const scale = useSharedValue(1);
  const anim = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const [outer, inner] = splitClass(className);
  return (
    <Animated.View className={outer} style={anim}>
      <Pressable
        {...props}
        className={inner}
        style={(state) => [
          typeof style === 'function' ? style(state) : style,
          { minWidth: 44, minHeight: 44 },
        ]}
        onPressIn={(e) => {
          scale.set(withSpring(scaleTo, PRESS));
          onPressIn?.(e);
        }}
        onPressOut={(e) => {
          scale.set(withSpring(1, PRESS));
          onPressOut?.(e);
        }}
      />
    </Animated.View>
  );
}

const EASE = Easing.out(Easing.cubic);
/** 목록에서 행이 빠지거나 들어올 때 남은 행이 자리를 메우며 움직인다 (화면에서 직접 만든 목록도 layout에 쓴다) */
export const LIST_LAYOUT = LinearTransition.duration(MOTION.enter).easing(EASE);

/** 목록 항목이 차례로 떠오르며 나타난다 (index마다 MOTION.stagger, 8번째부터는 같이) */
export const Appear = ({
  index = 0,
  children,
  className,
}: {
  index?: number;
  children: ReactNode;
  className?: string;
}) => (
  <Animated.View
    entering={FadeInDown.duration(MOTION.enter)
      .delay(Math.min(index, 8) * MOTION.stagger)
      .easing(EASE)}
    layout={LIST_LAYOUT}
    className={className}
  >
    {children}
  </Animated.View>
);

/**
 * 자리를 그대로 두고 내용만 바꾼다: 상태가 바뀌는 글자 · 아이콘 (재생 ↔ 일시정지 등).
 * k가 바뀌면 MOTION.exit 동안 반쯤 사라졌다가 새 내용으로 돌아온다. 동작 줄이기면 바로 바꾼다
 */
export function Swap({
  k,
  children,
  className,
}: {
  k: string | number;
  children: ReactNode;
  className?: string;
}) {
  const reduced = useReducedMotion();
  // shown: 지금 보이는 키와 그 키의 마지막 내용 (바뀌는 동안 옛 내용을 보여 주려고)
  const [shown, setShown] = useState({ k, node: children });
  const current = shown.k === k || reduced;
  if (current && (shown.k !== k || shown.node !== children)) setShown({ k, node: children });
  const opacity = useSharedValue(1);
  const style = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  useEffect(() => {
    const half = MOTION.exit / 2;
    // 바뀌는 도중 원래 키로 돌아오면 흐려진 채 남지 않게 되살린다
    if (current) return void opacity.set(withTiming(1, { duration: half, easing: EASE }));
    opacity.set(withTiming(0, { duration: half, easing: EASE }));
    // ponytail: 바꾸는 순간은 JS 타이머 — 바쁠 때 몇 프레임 늦을 수 있지만 페이드 자체는 UI 스레드
    const t = setTimeout(() => {
      setShown((s) => ({ ...s, k }));
      opacity.set(withTiming(1, { duration: half, easing: EASE }));
    }, half);
    return () => clearTimeout(t);
  }, [current, k, opacity]);
  return (
    <Animated.View className={className} style={style}>
      {current ? children : shown.node}
    </Animated.View>
  );
}

/**
 * 처음 나타날 때 시작값에서 값까지 굴러 올라간다 (결과 화면의 포인트 · 공부 시간).
 * from은 같은 모양의 시작값(예: '+0P', '00:00:00'). 이후 값이 바뀌면 Roll처럼 자리별로 굴린다
 */
export function RollUp({
  value,
  from,
  className,
}: {
  value: string;
  from: string;
  className?: string;
}) {
  const [shown, setShown] = useState(from);
  useEffect(() => {
    // 화면이 뜬 뒤 한 박자 쉬고 굴려야 굴러 올라가는 것이 보인다
    const t = setTimeout(() => setShown(value), MOTION.enter);
    return () => clearTimeout(t);
  }, [value]);
  return <Roll value={shown} className={className} />;
}

/** 굴리는 숫자의 한 자리: 0~9를 세로로 쌓아 두고 transform으로 옮긴다 */
function Digit({ d, h, className }: { d: number; h: number; className?: string }) {
  const y = useSharedValue(-d * h);
  useEffect(() => {
    y.set(withTiming(-d * h, { duration: MOTION.enter, easing: EASE }));
  }, [d, h, y]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: y.get() }] }));
  return (
    <View style={{ height: h, overflow: 'hidden' }}>
      <Animated.View style={style}>
        {DIGITS.map((n) => (
          <Text key={n} className={className} style={TABULAR}>
            {n}
          </Text>
        ))}
      </Animated.View>
    </View>
  );
}
const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const TABULAR = { fontVariant: ['tabular-nums' as const] };

/**
 * 바뀌는 숫자를 자리별로 굴린다 (점수 · 횟수 · 시간). 숫자가 아닌 글자(, : %)는 그대로 둔다.
 * className은 글자 크기 · 색 (Text와 같게). 읽기 도구에는 값 전체를 한 번에 읽힌다
 */
export function Roll({ value, className }: { value: string | number; className?: string }) {
  const s = String(value);
  // 글자 크기를 키운 설정에서도 맞도록 한 줄 높이를 재서 쓴다. 잴 때 쓰는 보이지 않는 글자는 값 전체라
  // 화면 테스트도 Text처럼 getByText(값)으로 찾는다
  const [h, setH] = useState(0);
  return (
    <View className="flex-row" accessible accessibilityLabel={s}>
      <Text
        className={className}
        style={[TABULAR, { position: 'absolute', opacity: 0 }]}
        onLayout={(e) => setH(e.nativeEvent.layout.height)}
        importantForAccessibility="no"
      >
        {s}
      </Text>
      {s.split('').map((c, i) => {
        // 오른쪽에서 센 자리를 key로 — 자릿수가 늘어도 1의 자리는 1의 자리로 굴러간다
        const key = s.length - i;
        return /\d/.test(c) && h > 0 ? (
          <Digit key={key} d={Number(c)} h={h} className={className} />
        ) : (
          <Text key={key} className={className} style={TABULAR}>
            {c}
          </Text>
        );
      })}
    </View>
  );
}

/** 탭 안의 화면인지 (하단 여백 계산용) */
const useInTabs = () => useSegments()[0] === '(tabs)';

export function Screen({
  children,
  footer,
  overlay,
  dark,
  className,
  pad = true,
  scroll = true,
  top = true,
  scrollRef,
  onScroll,
  canvas,
}: {
  children: ReactNode;
  footer?: ReactNode;
  /** 본문 위에 떠 있는 것(스크롤하지 않고, 아래 버튼 위에서 끝난다). 예: 아바타 선생님 */
  overlay?: ReactNode;
  dark?: boolean;
  /** 회색 캔버스 바탕 + 흰 카드 (개편된 화면) */
  canvas?: boolean;
  className?: string;
  pad?: boolean;
  scroll?: boolean;
  top?: boolean;
  scrollRef?: React.Ref<ScrollView>;
  onScroll?: ScrollViewProps['onScroll'];
}) {
  const insets = useSafeAreaInsets();
  const inTabs = useInTabs();
  // Canvas 안의 Screen은 canvas를 따로 주지 않아도 회색 바탕
  const outer = useSurface();
  const onCanvas = canvas || outer === 'canvas';
  const body = scroll ? (
    <ScrollView
      ref={scrollRef}
      onScroll={onScroll}
      scrollEventThrottle={32}
      keyboardShouldPersistTaps="handled"
      contentContainerClassName={cx(pad && 'px-6 pb-14', className)}
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  ) : (
    <View className={cx('flex-1', pad && 'px-6', className)}>{children}</View>
  );
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className={cx(
        'flex-1',
        dark
          ? 'bg-black'
          : canvas
            ? 'bg-canvas'
            : outer === 'canvas'
              ? 'bg-transparent' // Canvas가 바탕을 칠한다
              : 'bg-white',
      )}
      style={{ paddingTop: top ? insets.top : 0 }}
    >
      <SurfaceCtx.Provider value={onCanvas ? 'canvas' : 'legacy'}>
        <View className="flex-1">
          {body}
          {overlay}
        </View>
        {footer && (
          <View
            className="px-6 pt-4"
            // 아래 버튼이 탭 막대 · 홈 표시줄에 붙어 보이지 않게 (탭 안 20, 밖은 홈 표시줄 + 12)
            style={{ paddingBottom: inTabs ? 20 : Math.max(insets.bottom + 12, 24) }}
          >
            {footer}
          </View>
        )}
      </SurfaceCtx.Provider>
    </KeyboardAvoidingView>
  );
}

export function Header({
  title,
  sub,
  right,
  back = true,
  onBack,
  center,
  large = true,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  back?: boolean;
  onBack?: () => void;
  center?: boolean;
  large?: boolean;
}) {
  const goBack = onBack ?? (() => router.back());
  if (center)
    return (
      <View className="-mx-5 mb-3 h-control-lg flex-row items-center justify-center border-b border-line px-5">
        {back && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="뒤로"
            onPress={goBack}
            hitSlop={10}
            className="absolute left-2 h-control w-control items-center justify-center"
          >
            <ChevronLeft size={ICON.lg} color={C.ink} />
          </Pressable>
        )}
        <Text className="text-headline font-bold text-ink">{title}</Text>
        <View className="absolute right-4">{right}</View>
      </View>
    );
  return (
    <View className="pt-2 pb-3">
      <View className="h-control flex-row items-center justify-between">
        {back ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="뒤로"
            onPress={goBack}
            hitSlop={10}
            className="-ml-3 h-control w-control items-center justify-center"
          >
            <ChevronLeft size={ICON.lg} color={C.ink} />
          </Pressable>
        ) : (
          <View />
        )}
        {right}
      </View>
      {title ? (
        <Text className={cx('font-bold text-ink', large ? 'text-title2' : 'text-headline')}>
          {title}
        </Text>
      ) : null}
      {sub ? <Text className="mt-1 text-footnote text-sub">{sub}</Text> : null}
    </View>
  );
}

export function Title({
  children,
  sub,
  right,
}: {
  children: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <View className="flex-row items-end justify-between pt-6 pb-6">
      <View>
        <Text className="text-page font-bold text-ink">{children}</Text>
        {sub ? <Text className="mt-1 text-footnote text-sub">{sub}</Text> : null}
      </View>
      {right}
    </View>
  );
}

export const Label = ({ children, right }: { children: ReactNode; right?: ReactNode }) => (
  <View className="mt-8 mb-3 flex-row items-center justify-between px-1">
    {typeof children === 'string' ? (
      <Text className="text-footnote text-sub">{children}</Text>
    ) : (
      children
    )}
    {right}
  </View>
);

type BtnKind = 'primary' | 'outline' | 'cream' | 'dark' | 'sun' | 'danger' | 'ghost' | 'gray';
const BTN: Record<BtnKind, [string, string]> = {
  primary: ['bg-brand', 'text-white'],
  outline: ['border border-brand/40 bg-white', 'text-ink'],
  cream: ['', 'text-ink'], // 바탕은 면에 따라 (FILL)
  dark: ['bg-ink', 'text-white'],
  sun: ['bg-sun', 'text-ink'],
  danger: ['bg-danger', 'text-white'],
  ghost: ['', 'text-sub'],
  gray: ['bg-sub', 'text-white'],
};
export function Btn({
  children,
  kind = 'primary',
  onPress,
  className,
  disabled,
  small,
  loading,
  icon,
}: {
  children: ReactNode;
  kind?: BtnKind;
  onPress?: () => void;
  className?: string;
  disabled?: boolean;
  small?: boolean;
  loading?: boolean;
  icon?: ReactNode;
}) {
  const surface = useSurface();
  const [base, fg] = BTN[kind];
  const bg = kind === 'cream' ? FILL[surface] : base;
  return (
    <Tap
      accessibilityRole="button"
      accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }}
      disabled={disabled || loading}
      onPress={onPress}
      className={cx(
        'flex-row items-center justify-center rounded-2xl px-4',
        small ? 'h-control' : 'h-control-lg',
        bg,
        (disabled || loading) && 'opacity-40',
        className,
      )}
    >
      {loading ? (
        <ActivityIndicator color={fg === 'text-white' ? '#fff' : C.ink} />
      ) : (
        <>
          {icon}
          {typeof children === 'string' ? (
            <Text
              className={cx(
                'font-semibold',
                small ? 'text-subhead' : 'text-callout',
                fg,
                icon ? 'ml-1.5' : '',
              )}
            >
              {children}
            </Text>
          ) : (
            children
          )}
        </>
      )}
    </Tap>
  );
}

export function Card({
  children,
  className,
  onPress,
  tone = 'cream',
}: {
  children: ReactNode;
  className?: string;
  onPress?: () => void;
  /** cream: 면에 맞춘 기본 카드 (캔버스 위 흰 카드 · 흰 면 안 채움 · 개편 전 크림) */
  tone?: 'cream' | 'white' | 'mint' | 'night';
}) {
  const surface = useSurface();
  const canvas = surface === 'canvas';
  const t = {
    cream: FILL[surface],
    // 캔버스 위 흰 카드는 테두리 없이 바탕과의 밝기 차이로 나눈다
    white: canvas ? 'bg-white' : 'bg-white border border-line',
    mint: 'bg-mint',
    night: 'bg-night',
  }[tone];
  const shape = cx(canvas ? 'rounded-card' : 'rounded-2xl', t, className);
  const body = tone === 'night' ? children : <OnWhite>{children}</OnWhite>;
  if (!onPress) return <View className={shape}>{body}</View>;
  return (
    <Tap scaleTo={0.98} onPress={onPress} className={shape}>
      {body}
    </Tap>
  );
}

export function Row({
  children,
  sub,
  right,
  onPress,
  chevron,
  danger,
  icon: Icon,
}: {
  children: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  onPress?: () => void;
  chevron?: boolean;
  danger?: boolean;
  /** 왼쪽 아이콘 (lucide 컴포넌트) */
  icon?: LucideIcon;
}) {
  const inner = (
    <>
      {Icon && <Icon size={ICON.md} color={danger ? C.danger : C.brand} />}
      <View className="flex-1">
        {typeof children === 'string' ? (
          <Text className={cx('text-callout', danger ? 'text-danger' : 'text-ink')}>
            {children}
          </Text>
        ) : (
          children
        )}
        {sub ? <Text className="mt-0.5 text-caption text-sub">{sub}</Text> : null}
      </View>
      {right}
      {chevron && <ChevronRight size={ICON.md} color={C.sub} />}
    </>
  );
  const cls = 'min-h-14 flex-row items-center gap-3.5 px-5 py-4';
  return onPress ? (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      className={cx(cls, 'active:bg-black/5')}
    >
      {inner}
    </Pressable>
  ) : (
    <View className={cls}>{inner}</View>
  );
}

export const Group = ({ children, className }: { children: ReactNode; className?: string }) => {
  const surface = useSurface();
  const canvas = surface === 'canvas';
  const items = (Array.isArray(children) ? children : [children]).flat().filter(Boolean);
  return (
    <View
      className={cx(
        'overflow-hidden',
        canvas ? 'rounded-card' : 'rounded-2xl',
        FILL[surface],
        className,
      )}
    >
      <OnWhite>
        {items.map((c, i) => (
          <Appear
            key={i}
            index={i}
            className={i ? cx('border-t', canvas ? 'border-fill' : 'border-line') : ''}
          >
            {c}
          </Appear>
        ))}
      </OnWhite>
    </View>
  );
};

export function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <Switch
      accessibilityLabel={label}
      value={on}
      onValueChange={onChange}
      trackColor={{ true: C.brand, false: C['cream-2'] }}
      thumbColor="#fff"
      ios_backgroundColor={C['cream-2']}
    />
  );
}

export function Chip({
  children,
  on,
  onPress,
  className,
  small,
}: {
  children: ReactNode;
  on?: boolean;
  onPress?: () => void;
  className?: string;
  small?: boolean;
}) {
  const surface = useSurface();
  return (
    <Tap
      accessibilityRole="button"
      accessibilityState={{ selected: !!on }}
      onPress={onPress}
      hitSlop={small ? 8 : 4}
      className={cx(
        'items-center justify-center overflow-hidden rounded-full',
        small ? 'h-8 px-3' : 'h-control-sm px-4',
        FILL[surface],
        className,
      )}
    >
      <OnFill on={!!on} />
      {typeof children === 'string' ? (
        <Text
          className={cx(
            'font-medium',
            small ? 'text-footnote' : 'text-subhead',
            on ? 'text-white' : 'text-ink/80',
          )}
        >
          {children}
        </Text>
      ) : (
        children
      )}
    </Tap>
  );
}

export function Segment<T extends string>({
  items,
  value,
  onChange,
  className,
}: {
  items: readonly T[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  const surface = useSurface();
  // 고른 칸의 브랜드색 판이 옆 칸으로 미끄러진다 (위치가 이어져 어느 칸으로 옮겼는지 보인다)
  const [w, setW] = useState(0);
  const at = Math.max(0, items.indexOf(value));
  const x = useSharedValue(0);
  useEffect(() => {
    x.set(withTiming(at * w, { duration: MOTION.exit, easing: EASE }));
  }, [at, w, x]);
  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() }] }));
  return (
    <View
      className={cx('flex-row rounded-xl p-1', FILL[surface], className)}
      // 칸 폭 = (전체 - 양옆 p-1) / 칸 수. Pressable의 onLayout은 앱에서 불리지 않아 바깥 상자로 잰다
      onLayout={(e) => setW((e.nativeEvent.layout.width - 8) / items.length)}
    >
      {w > 0 && (
        <Animated.View
          pointerEvents="none"
          className="h-control-sm absolute top-1 left-1 rounded-lg bg-brand"
          style={[{ width: w }, thumb]}
        />
      )}
      {items.map((it) => (
        <Pressable
          key={it}
          accessibilityRole="tab"
          accessibilityState={{ selected: value === it }}
          onPress={() => onChange(it)}
          className={cx(
            'h-control-sm flex-1 items-center justify-center rounded-lg',
            // 폭을 재기 전(첫 그림)에는 판 대신 칸 자체를 칠한다
            w === 0 && value === it && 'bg-brand',
          )}
        >
          <Text
            className={cx('text-subhead font-medium', value === it ? 'text-white' : 'text-sub')}
          >
            {it}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/** 고르면 채움색이 바탕 위로 부드럽게 차오른다 (칩 · 퀴즈 보기 같은 선택 칸, MOTION.exit). 부모는 overflow-hidden */
export function OnFill({ on, fill = 'bg-brand' }: { on: boolean; fill?: string }) {
  const v = useSharedValue(on ? 1 : 0);
  useEffect(() => {
    v.set(withTiming(on ? 1 : 0, { duration: MOTION.exit, easing: EASE }));
  }, [on, v]);
  const style = useAnimatedStyle(() => ({ opacity: v.get() }));
  return (
    <Animated.View pointerEvents="none" className={cx('absolute inset-0', fill)} style={style} />
  );
}

export function Input({
  value,
  onChangeText,
  placeholder,
  right,
  multiline,
  className,
  autoFocus,
  invalid,
  ...rest
}: TextInputProps & { right?: ReactNode; invalid?: boolean }) {
  const surface = useSurface();
  return (
    <View
      className={cx(
        'flex-row items-center rounded-xl border px-4',
        surface === 'white' ? 'bg-fill' : 'bg-white',
        invalid ? 'border-danger' : surface === 'legacy' ? 'border-line' : 'border-transparent',
        className,
      )}
    >
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={C.sub}
        multiline={multiline}
        autoFocus={autoFocus}
        className={cx('flex-1 text-callout text-ink', multiline ? 'min-h-28 py-3' : 'h-control-lg')}
        style={multiline ? { textAlignVertical: 'top' } : undefined}
        {...rest}
      />
      {typeof right === 'string' ? <Text className="text-caption text-sub">{right}</Text> : right}
    </View>
  );
}

export function Search({
  value,
  onChangeText,
  placeholder,
  onSubmit,
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  onSubmit?: () => void;
}) {
  const surface = useSurface();
  return (
    <View className={cx('h-control flex-row items-center rounded-xl px-4', FILL[surface])}>
      <SearchIcon size={ICON.sm} color={C.sub} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmit}
        returnKeyType="search"
        placeholder={placeholder}
        placeholderTextColor={C.sub}
        className="ml-2 h-control flex-1 text-subhead text-ink"
      />
    </View>
  );
}

// ponytail: 닫힘 시간 기준 대기. Modal의 닫힘 이벤트를 믿을 수 있게 되면 그쪽으로 바꾼다
// 테스트는 jest.setup.js에서 0으로 둔다 (기다림 자체는 modal-navigation-sim-review 테스트가 본다)
const modalCloseMs = () =>
  (globalThis as { MODAL_CLOSE_MS?: number }).MODAL_CLOSE_MS ?? MOTION.exit + 120;
let closingUntil = 0;
const markClosing = () => {
  closingUntil = Date.now() + modalCloseMs();
};
const closingLeft = () => Math.max(0, closingUntil - Date.now());

/** 닫힐 때 나가는 애니메이션이 끝날 때까지 Modal을 띄워 둔다 */
function useMounted(open: boolean) {
  const [mounted, setMounted] = useState(open);
  const [wasOpen, setWasOpen] = useState(open);
  const [, wake] = useState(0);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open && mounted) markClosing();
  }
  // 닫히는 Modal이 남아 있을 때 새 Modal을 띄우면 iOS가 무시한다. 다 닫힌 뒤에 띄운다
  if (open && !mounted && closingLeft() === 0) setMounted(true);
  useEffect(() => {
    if (open && !mounted) {
      const t = setTimeout(() => wake((n) => n + 1), closingLeft());
      return () => clearTimeout(t);
    }
    if (open || !mounted) return;
    const t = setTimeout(() => setMounted(false), MOTION.exit);
    return () => clearTimeout(t);
  }, [open, mounted]);
  return mounted;
}

/** 하단 시트. 스프링으로 올라오고 바깥(딤)을 누르면 내려가며 닫힌다. */
/**
 * 시트를 닫은 뒤 사진 · 파일 선택기 같은 시스템 화면을 열 때 기다린다.
 * 닫히는 중인 Modal 위에 띄우면 Modal이 사라지며 선택기도 함께 닫힌다(iOS).
 */
export const afterSheetClosed = () =>
  new Promise<void>((resolve) => setTimeout(resolve, modalCloseMs()));

export function Sheet({
  open,
  onClose,
  children,
  title,
  right,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: ReactNode;
  right?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const mounted = useMounted(open);
  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1 justify-end"
      >
        {open && (
          <Animated.View
            entering={FadeIn.duration(MOTION.enter)}
            exiting={FadeOut.duration(MOTION.exit)}
            className="absolute inset-0"
          >
            <Pressable accessibilityLabel="닫기" className="flex-1 bg-black/45" onPress={onClose} />
          </Animated.View>
        )}
        {open && (
          <Animated.View
            entering={SlideInDown.duration(MOTION.enter).easing(Easing.out(Easing.cubic))}
            exiting={SlideOutDown.duration(MOTION.exit).easing(Easing.in(Easing.cubic))}
            accessibilityViewIsModal
            className="max-h-[88%] rounded-t-sheet bg-white px-6 pt-2"
            style={{ paddingBottom: Math.max(insets.bottom + 12, 28) }}
          >
            <View className="mb-3 h-1 w-10 self-center rounded-full bg-fill" />
            {(title || right) && (
              <View className="mb-3 flex-row items-center justify-between">
                <Text className="text-headline font-bold text-ink">{title}</Text>
                {right ?? (
                  <Pressable
                    accessibilityLabel="닫기"
                    onPress={onClose}
                    className="-mr-3 h-control w-control items-center justify-center"
                  >
                    <X size={ICON.md} color={C.sub} />
                  </Pressable>
                )}
              </View>
            )}
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <OnWhite>{children}</OnWhite>
            </ScrollView>
          </Animated.View>
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function Dialog({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose?: () => void;
  children: ReactNode;
}) {
  const mounted = useMounted(open);
  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View className="flex-1 items-center justify-center px-8">
        {open && (
          <Animated.View
            entering={FadeIn.duration(MOTION.enter)}
            exiting={FadeOut.duration(MOTION.exit)}
            className="absolute inset-0"
          >
            <Pressable
              accessibilityLabel="대화상자 닫기"
              className="flex-1 bg-black/45"
              onPress={onClose}
            />
          </Animated.View>
        )}
        {open && (
          <Animated.View
            entering={FadeInDown.duration(MOTION.enter).easing(Easing.out(Easing.cubic))}
            exiting={FadeOut.duration(MOTION.exit)}
            accessibilityViewIsModal
            className="w-full items-center rounded-sheet bg-white p-6"
          >
            <OnWhite>{children}</OnWhite>
          </Animated.View>
        )}
      </View>
    </Modal>
  );
}

/** 경고 · 오류 다이얼로그 (p.97~102 공통 패턴) */
export function Alert({
  open,
  icon = '!',
  tone = 'danger',
  title,
  body,
  primary,
  secondary,
  onPrimary,
  onSecondary,
  onClose,
  extra,
}: {
  open: boolean;
  icon?: ReactNode;
  tone?: 'danger' | 'sun' | 'brand';
  title: ReactNode;
  body?: ReactNode;
  primary: string;
  secondary?: string;
  onPrimary: () => void;
  onSecondary?: () => void;
  /** 배경 · 뒤로가기로 닫을 때. 없으면 onSecondary (두 번째 버튼이 위험한 동작이면 따로 준다) */
  onClose?: () => void;
  extra?: ReactNode;
}) {
  const [bg, fg] = {
    danger: ['bg-danger/10', 'text-danger'],
    sun: ['bg-sun/20', 'text-sun-ink'],
    brand: ['bg-mint', 'text-brand'],
  }[tone];
  return (
    <Dialog open={open} onClose={onClose ?? onSecondary}>
      <View className={cx('mb-3 h-12 w-12 items-center justify-center rounded-full', bg)}>
        {typeof icon === 'string' ? (
          <Text className={cx('text-title2 font-bold', fg)}>{icon}</Text>
        ) : (
          icon
        )}
      </View>
      {typeof title === 'string' ? (
        <Text className="text-center text-headline font-bold leading-snug text-ink">{title}</Text>
      ) : (
        title
      )}
      {body ? (
        <Text className="mt-2 text-center text-footnote leading-5 text-sub">{body}</Text>
      ) : null}
      {extra}
      <View className="mt-5 w-full flex-row gap-2">
        {secondary && (
          <View className="flex-1">
            <Btn kind="outline" small onPress={onSecondary}>
              {secondary}
            </Btn>
          </View>
        )}
        <View className="flex-1">
          <Btn small onPress={onPrimary}>
            {primary}
          </Btn>
        </View>
      </View>
    </Dialog>
  );
}

export function Empty({
  icon,
  title,
  body,
  children,
}: {
  icon: ReactNode;
  title: string;
  body?: string;
  children?: ReactNode;
}) {
  return (
    <View className="items-center px-6 py-14">
      <View className="mb-4 h-16 w-16 items-center justify-center rounded-full bg-mint">
        {typeof icon === 'string' ? <Text className="text-title1">{icon}</Text> : icon}
      </View>
      <Text className="text-center text-body font-bold text-ink">{title}</Text>
      {body ? (
        <Text className="mt-1.5 text-center text-footnote leading-5 text-sub">{body}</Text>
      ) : null}
      {children && <View className="mt-6 w-[220px]">{children}</View>}
    </View>
  );
}

export function Success({
  title,
  body,
  card,
  children,
}: {
  title: string;
  body: string;
  card?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <View className="items-center pt-24">
      <Animated.View
        entering={FadeIn.duration(MOTION.enter)}
        className="h-20 w-20 items-center justify-center rounded-full bg-mint"
      >
        <Check size={ICON.xl} color={C.brand} />
      </Animated.View>
      <Text className="mt-5 text-title3 font-bold text-ink">{title}</Text>
      <Text className="mt-1.5 text-center text-footnote text-sub">{body}</Text>
      {card && <View className="mt-6 w-full">{card}</View>}
      {children}
    </View>
  );
}

export const Badge = ({
  children,
  tone = 'mint',
}: {
  children: ReactNode;
  tone?: 'mint' | 'sun' | 'gray' | 'dark' | 'danger';
}) => {
  const [bg, fg] = {
    mint: ['bg-mint', 'text-brand'],
    sun: ['bg-sun', 'text-ink'],
    gray: ['bg-cream-2', 'text-sub'],
    dark: ['bg-brand', 'text-white'],
    danger: ['bg-danger/10', 'text-danger'],
  }[tone];
  return (
    <View className={cx('h-6 items-center justify-center self-start rounded-full px-2.5', bg)}>
      <Text className={cx('text-caption font-semibold', fg)}>{children}</Text>
    </View>
  );
};

export const Avatar = ({
  name,
  size = 44,
  face,
  uri,
  tone = 'brand',
}: {
  name?: string;
  size?: number;
  face?: string;
  uri?: string | null;
  tone?: 'brand' | 'mint';
}) => {
  // 주소가 아닌 값(이모지 아바타 등)을 이미지로 읽으면 빈 원이 된다
  if (uri && !/^(https?:|file:|content:|data:image\/)/i.test(uri)) {
    face = uri;
    uri = null;
  }
  const svgData = !!uri && /^data:image\/svg\+xml[;,]/i.test(uri);
  let xml: string | undefined;
  if (svgData) {
    try {
      const decoded = decodeURIComponent(uri!.slice(uri!.indexOf(',') + 1));
      if (decoded.trim().startsWith('<svg')) xml = decoded;
    } catch {
      /* 잘못된 데이터 URI는 이름으로 대신 표시한다. */
    }
  }
  const fallback = (
    <Text
      className={cx('font-bold', tone === 'brand' ? 'text-white' : 'text-brand')}
      style={{ fontSize: face ? size * 0.55 : size * 0.4 }}
    >
      {face ?? (name && name.length > 1 ? name.slice(-2, -1) : name)}
    </Text>
  );
  return (
    <View
      className={cx(
        'items-center justify-center rounded-full',
        tone === 'brand' ? 'bg-brand' : 'bg-mint',
      )}
      style={{ width: size, height: size }}
    >
      {xml ? (
        <View accessibilityRole="image" accessibilityLabel="프로필 사진" accessible>
          <SvgXml xml={xml} width={size} height={size} fallback={fallback} onError={() => {}} />
        </View>
      ) : uri && !svgData ? (
        <Image
          accessibilityLabel="프로필 사진"
          source={{ uri }}
          style={{ width: size, height: size, borderRadius: size / 2 }}
        />
      ) : (
        fallback
      )}
    </View>
  );
};
/** 막대 진행률 — 값이 바뀌면 부드럽게 채운다 (width 대신 transform) */
export function Progress({
  value,
  className,
  tone = 'brand',
  onDark,
}: {
  value: number;
  className?: string;
  tone?: 'brand' | 'sun' | 'danger';
  /** 어두운 카드 위 (홈 집중 카드) */
  onDark?: boolean;
}) {
  const v = Math.max(0, Math.min(100, value)) / 100;
  const scale = useSharedValue(v);
  useEffect(() => {
    scale.set(withTiming(v, { duration: MOTION.enter, easing: Easing.out(Easing.cubic) }));
  }, [v, scale]);
  const anim = useAnimatedStyle(() => ({ transform: [{ scaleX: scale.value }] }));
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(v * 100) }}
      className={cx(
        'h-1.5 overflow-hidden rounded-full',
        onDark ? 'bg-white/10' : 'bg-cream-2',
        className,
      )}
    >
      <Animated.View
        className={cx(
          'h-full w-full rounded-full',
          { brand: 'bg-brand', sun: 'bg-sun', danger: 'bg-danger' }[tone],
        )}
        style={[{ transformOrigin: 'left' }, anim]}
      />
    </View>
  );
}

/** 원형(파이) 진행률 — AI 변환 · 삭제 중 표시 */
export function Pie({
  value,
  size = 120,
  color = C.brand,
}: {
  value: number;
  size?: number;
  color?: string;
}) {
  const r = size / 2;
  const v = Math.max(0, Math.min(99.99, value)) / 100;
  const a = v * 2 * Math.PI - Math.PI / 2;
  const x = r + r * Math.cos(a),
    y = r + r * Math.sin(a);
  return (
    <Svg width={size} height={size}>
      {value >= 100 ? (
        <Circle cx={r} cy={r} r={r} fill={color} />
      ) : (
        v > 0 && (
          <Path
            d={`M${r},${r} L${r},0 A${r},${r} 0 ${v > 0.5 ? 1 : 0} 1 ${x},${y} Z`}
            fill={color}
          />
        )
      )}
    </Svg>
  );
}

/** 원형 링 진행률 — 프로필 생성 */
export function Ring({
  value,
  size = 176,
  stroke = 8,
  children,
}: {
  value: number;
  size?: number;
  stroke?: number;
  children?: ReactNode;
}) {
  const r = (size - stroke) / 2;
  const len = 2 * Math.PI * r;
  return (
    <View style={{ width: size, height: size }} className="items-center justify-center">
      <Svg
        width={size}
        height={size}
        style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}
      >
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={C.mint}
          strokeWidth={stroke}
          fill="none"
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={C.brand}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${len}`}
          strokeDashoffset={len * (1 - value / 100)}
          strokeLinecap="round"
        />
      </Svg>
      {children}
    </View>
  );
}

export const Dashed = ({ children, onPress }: { children: string; onPress: () => void }) => (
  <Tap
    accessibilityRole="button"
    scaleTo={0.98}
    onPress={onPress}
    className="mt-2 h-control-lg items-center justify-center rounded-2xl border border-dashed border-brand/50 active:bg-mint"
  >
    <Text className="text-subhead font-semibold text-brand">{children}</Text>
  </Tap>
);

export const Fade = ({ children, className }: { children: ReactNode; className?: string }) => (
  <Animated.View entering={FadeIn} className={className}>
    {children}
  </Animated.View>
);

export const Loading = () => (
  <View className="flex-1 items-center justify-center py-20">
    <ActivityIndicator color={C.brand} />
  </View>
);

/** 0→100 으로 차오르는 진행률 (로컬 연출용) */
export function useProgress(ms: number, onDone?: () => void, start = 0) {
  const [v, setV] = useState(start);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  useEffect(() => {
    const step = 100 / (ms / 60);
    const id = setInterval(() => setV((p) => Math.min(100, p + step)), 60);
    return () => clearInterval(id);
  }, [ms]);
  useEffect(() => {
    if (v >= 100) done.current?.();
  }, [v]);
  return Math.round(v);
}

/** 아래에 고정되지 않는 두 버튼 가로 배치 */
export const Two = ({ children }: { children: [ReactNode, ReactNode] }) => (
  <View className="flex-row gap-2">
    <View className="flex-1">{children[0]}</View>
    <View className="flex-1">{children[1]}</View>
  </View>
);
