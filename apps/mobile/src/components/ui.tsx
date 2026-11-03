import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
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
  SlideInDown,
  SlideOutDown,
  ZoomIn,
  useAnimatedStyle,
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
      .easing(Easing.out(Easing.cubic))}
    className={className}
  >
    {children}
  </Animated.View>
);

/** 탭 안의 화면인지 (하단 여백 계산용) */
const useInTabs = () => useSegments()[0] === '(tabs)';

export function Screen({
  children,
  footer,
  dark,
  className,
  pad = true,
  scroll = true,
  top = true,
  scrollRef,
  onScroll,
}: {
  children: ReactNode;
  footer?: ReactNode;
  dark?: boolean;
  className?: string;
  pad?: boolean;
  scroll?: boolean;
  top?: boolean;
  scrollRef?: React.Ref<ScrollView>;
  onScroll?: ScrollViewProps['onScroll'];
}) {
  const insets = useSafeAreaInsets();
  const inTabs = useInTabs();
  const body = scroll ? (
    <ScrollView
      ref={scrollRef}
      onScroll={onScroll}
      scrollEventThrottle={32}
      keyboardShouldPersistTaps="handled"
      contentContainerClassName={cx(pad && 'px-5 pb-8', className)}
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  ) : (
    <View className={cx('flex-1', pad && 'px-5', className)}>{children}</View>
  );
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className={cx('flex-1', dark ? 'bg-black' : 'bg-white')}
      style={{ paddingTop: top ? insets.top : 0 }}
    >
      <View className="flex-1">{body}</View>
      {footer && (
        <View
          className="px-5 pt-2"
          style={{ paddingBottom: inTabs ? 12 : Math.max(insets.bottom, 16) }}
        >
          {footer}
        </View>
      )}
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
    <View className="flex-row items-end justify-between pt-4 pb-3">
      <View>
        <Text className="text-title1 font-bold text-ink">{children}</Text>
        {sub ? <Text className="mt-1 text-footnote text-sub">{sub}</Text> : null}
      </View>
      {right}
    </View>
  );
}

export const Label = ({ children, right }: { children: ReactNode; right?: ReactNode }) => (
  <View className="mt-5 mb-2 flex-row items-center justify-between">
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
  cream: ['bg-cream', 'text-ink'],
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
  const [bg, fg] = BTN[kind];
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
  tone?: 'cream' | 'white' | 'mint' | 'night';
}) {
  const t = {
    cream: 'bg-cream',
    white: 'bg-white border border-line',
    mint: 'bg-mint',
    night: 'bg-night',
  }[tone];
  if (!onPress) return <View className={cx('rounded-2xl', t, className)}>{children}</View>;
  return (
    <Tap scaleTo={0.98} onPress={onPress} className={cx('rounded-2xl', t, className)}>
      {children}
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
  const cls = 'min-h-14 flex-row items-center gap-3 px-4 py-3';
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
  const items = (Array.isArray(children) ? children : [children]).flat().filter(Boolean);
  return (
    <View className={cx('overflow-hidden rounded-2xl bg-cream', className)}>
      {items.map((c, i) => (
        <Appear key={i} index={i} className={i ? 'border-t border-line' : ''}>
          {c}
        </Appear>
      ))}
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
  return (
    <Tap
      accessibilityRole="button"
      accessibilityState={{ selected: !!on }}
      onPress={onPress}
      hitSlop={small ? 8 : 4}
      className={cx(
        'items-center justify-center rounded-full',
        small ? 'h-8 px-3' : 'h-control-sm px-4',
        on ? 'bg-brand' : 'bg-cream',
        className,
      )}
    >
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
  return (
    <View className={cx('flex-row rounded-xl bg-cream p-1', className)}>
      {items.map((it) => (
        <Pressable
          key={it}
          accessibilityRole="tab"
          accessibilityState={{ selected: value === it }}
          onPress={() => onChange(it)}
          className={cx(
            'h-control-sm flex-1 items-center justify-center rounded-lg',
            value === it && 'bg-brand',
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
  return (
    <View
      className={cx(
        'flex-row items-center rounded-xl border bg-white px-4',
        invalid ? 'border-danger' : 'border-line',
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
  return (
    <View className="h-control flex-row items-center rounded-xl bg-cream px-4">
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

/** 닫힐 때 나가는 애니메이션이 끝날 때까지 Modal을 띄워 둔다 */
function useMounted(open: boolean) {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  useEffect(() => {
    if (open || !mounted) return;
    const t = setTimeout(() => setMounted(false), MOTION.exit);
    return () => clearTimeout(t);
  }, [open, mounted]);
  return mounted;
}

/** 하단 시트. 스프링으로 올라오고 바깥(딤)을 누르면 내려가며 닫힌다. */
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
            entering={SlideInDown.springify().damping(24).stiffness(240)}
            exiting={SlideOutDown.duration(MOTION.exit).easing(Easing.in(Easing.cubic))}
            accessibilityViewIsModal
            className="max-h-[88%] rounded-t-3xl bg-white px-5 pt-2"
            style={{ paddingBottom: Math.max(insets.bottom, 20) }}
          >
            <View className="mb-3 h-1 w-10 self-center rounded-full bg-cream-2" />
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
              {children}
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
            <Pressable className="flex-1 bg-black/45" onPress={onClose} />
          </Animated.View>
        )}
        {open && (
          <Animated.View
            entering={ZoomIn.springify().damping(20).stiffness(260)}
            exiting={FadeOut.duration(MOTION.exit)}
            accessibilityViewIsModal
            className="w-full items-center rounded-3xl bg-white p-6"
          >
            {children}
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
  extra?: ReactNode;
}) {
  const [bg, fg] = {
    danger: ['bg-danger/10', 'text-danger'],
    sun: ['bg-sun/20', 'text-sun-ink'],
    brand: ['bg-mint', 'text-brand'],
  }[tone];
  return (
    <Dialog open={open} onClose={onSecondary}>
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
        entering={ZoomIn}
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
}: {
  value: number;
  className?: string;
  tone?: 'brand' | 'sun' | 'danger';
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
      className={cx('h-1.5 overflow-hidden rounded-full bg-cream-2', className)}
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
