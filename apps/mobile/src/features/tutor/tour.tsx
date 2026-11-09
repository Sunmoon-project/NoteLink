import { useEffect, useRef, useState, type RefObject } from 'react';
import { View, useWindowDimensions } from 'react-native';
import Animated, {
  ReduceMotion,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, type Href } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';
import { Text } from '@/components/text';
import { Alert, Btn, Swap, cx } from '@/components/ui';
import { useAuth } from '@/stores/auth';
import { Avatar3D, type Mood } from './avatar3d';
import { useEquippedAvatar } from './buddy';

// 이 기기에서 처음 안내를 본(또는 건너뛴) 계정. 로그아웃해도 남겨 다시 보여 주지 않는다
// ponytail: 기기 단위 기록(auth의 notelink.onboarded와 같은 방식) — 서버가 계정 값을 주면 바꾼다
const TOURED_KEY = 'notelink.toured';
async function touredIds() {
  try {
    const v = JSON.parse((await SecureStore.getItemAsync(TOURED_KEY)) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
/** 못 적으면 다음에 한 번 더 보여 줄 뿐이라 막지 않는다 */
export async function rememberToured(id: string) {
  const ids = await touredIds();
  if (!ids.includes(id))
    await SecureStore.setItemAsync(TOURED_KEY, JSON.stringify([...ids, id])).catch(() => {});
}

/** 안내 진행 상태. step이 -1이면 닫혀 있다 */
export const useTour = create<{ step: number; go: (step: number) => void }>((set) => ({
  step: -1,
  go: (step) => set({ step }),
}));

/** 가입을 마치고 처음 들어오면 한 번 안내를 연다(탭 화면에서 부름) */
export function useTourOnce(ready: boolean) {
  const userId = useAuth((s) => s.userId);
  useEffect(() => {
    if (!ready || !userId) return;
    let live = true;
    void touredIds().then((ids) => {
      if (live && !ids.includes(userId)) useTour.getState().go(0);
    });
    return () => {
      live = false;
    };
  }, [ready, userId]);
}

/* ── 짚어 줄 자리: 화면이 ref를 걸어 두면 안내가 그 자리를 재서 밝힌다 ── */

const targets = new Map<string, RefObject<View | null>>();
/** 안내가 짚을 버튼에 건다(예: 노트 탭의 + 버튼) */
export function useTourTarget(name: string) {
  const ref = useRef<View>(null);
  useEffect(() => {
    targets.set(name, ref);
    return () => {
      if (targets.get(name) === ref) targets.delete(name);
    };
  }, [name]);
  return ref;
}
type Rect = { x: number; y: number; w: number; h: number };
const measure = (name: string) =>
  new Promise<Rect | null>((resolve) => {
    const view = targets.get(name)?.current;
    if (!view) return resolve(null);
    view.measureInWindow((x, y, w, h) => resolve(w > 0 ? { x, y, w, h } : null));
  });

type Spot = { tab: number } | { target: string; tab: number } | { buddy: true } | null;
type Step = {
  route: Href;
  spot: Spot;
  /** 흐름(정리 0 · 학습 1 · 복습 2) 중 지금 단계 */
  flow: number | null;
  title: string;
  body: string;
};
/** 실제 화면을 옮겨 다니며 정리 → 학습 → 복습에서 무엇을 누르는지 짚어 준다 */
export const STEPS: Step[] = [
  {
    route: '/',
    spot: null,
    flow: null,
    title: '안녕하세요, 아바타 선생님이에요',
    body: '공부를 정리, 학습, 복습 순서로 이어 갈 수 있도록 실제 화면을 하나씩 보여 드릴게요.',
  },
  {
    route: '/note',
    spot: { tab: 1 },
    flow: 0,
    title: '정리: 노트 탭',
    body: '강의 녹음, 필기 사진, 문서를 과목별 학습 폴더에 모아 두는 곳이에요.',
  },
  {
    route: '/note',
    spot: { target: 'note-add', tab: 1 },
    flow: 0,
    title: '정리: 자료 올리기',
    body: '학습 폴더를 만든 뒤 여기를 눌러 실시간 녹음, 녹음 파일, 필기 촬영, 문서 중 하나를 올려 보세요. 올린 자료는 제가 AI로 요약하고 핵심을 정리해 드려요.',
  },
  {
    route: '/note',
    spot: { buddy: true },
    flow: 1,
    title: '학습: 저에게 물어보기',
    body: '정리가 끝난 노트를 열면 이 자리에 제가 있어요. 저를 누르고 궁금한 걸 물어보세요. 노트와 퀴즈에 있는 내용으로만 설명해 드려요.',
  },
  {
    route: '/quiz',
    spot: { tab: 2 },
    flow: 2,
    title: '복습: 퀴즈 탭',
    body: '정리한 노트로 퀴즈를 풀며 복습하는 곳이에요. 맞히면 칭찬하고, 틀리면 해설과 함께 응원해 드릴게요.',
  },
  {
    route: '/quiz',
    spot: { target: 'quiz-make', tab: 2 },
    flow: 2,
    title: '복습: 퀴즈 만들기',
    body: '여기서 노트를 골라 퀴즈를 만들어요. 틀린 문제는 유사 퀴즈와 오늘의 복습으로 다시 나와서 오래 기억할 수 있어요.',
  },
  {
    route: '/',
    spot: { tab: 0 },
    flow: null,
    title: '이제 시작해 볼까요?',
    body: '홈에서는 타이머로 공부 시간을 재고 오늘 할 일을 챙겨요. 먼저 첫 학습 폴더를 만들어 봐요.',
  },
];
const FLOW = ['정리', '학습', '복습'];

const TAB_BAR = 49; // iOS 기본 탭 막대 높이(홈 표시줄 제외)
const PAD = 8; // 밝힌 자리 둘레 여백
const R = ReduceMotion.System;
// 자리를 옮길 때: 빠르게 떠나 살짝 넘었다 돌아오며 멈춘다(stageshow motion.md: 작은 표시만 튕김)
const TRAVEL = { duration: 520, dampingRatio: 0.7, reduceMotion: R };
const AnimatedPath = Animated.createAnimatedComponent(Path);

/** 화면 전체를 어둡게 덮고 밝힐 자리만 둥근 사각형으로 뚫는다(evenodd) */
function hole(W: number, H: number, x: number, y: number, w: number, h: number) {
  'worklet';
  const r = Math.min(16, w / 2, h / 2);
  return (
    `M0 0H${W}V${H}H0Z ` +
    `M${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h - r}` +
    `Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x + r}Q${x} ${y + h} ${x} ${y + h - r}` +
    `V${y + r}Q${x} ${y} ${x + r} ${y}Z`
  );
}

function useSpring(v: SharedValue<number>, to: number) {
  useEffect(() => {
    v.set(withSpring(to, TRAVEL));
  }, [v, to]);
}

/**
 * 처음 안내(코치 마크). 탭 화면 위에 떠서 단계마다 실제 화면으로 옮겨 가고, 눌러야 할 자리를
 * 밝힌 채 아바타가 설명한다. 밝힌 자리는 다음 자리로 "슉" 옮겨 가고, 설명 카드는 그 자리를
 * 가리지 않게 위아래로 비켜 선다. 아래 '건너뛰기'는 한 번 더 묻는다.
 */
export function TourCoach() {
  const step = useTour((s) => s.step);
  const go = useTour((s) => s.go);
  const userId = useAuth((s) => s.userId);
  const avatar = useEquippedAvatar();
  const { width: W, height: H } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [spot, setSpot] = useState<Rect | null>(null);
  const [skip, setSkip] = useState(false);
  const on = step >= 0;
  const s = STEPS[Math.max(0, step)]!;
  const last = step === STEPS.length - 1;

  // 단계마다 그 화면으로 옮기고, 화면이 바뀐 뒤 짚을 자리를 잰다
  useEffect(() => {
    if (!on) return;
    router.navigate(s.route);
    let live = true;
    const tabRect = (i: number): Rect => {
      const cw = W / 5;
      return { x: cw * i + cw / 2 - 30, y: H - insets.bottom - TAB_BAR, w: 60, h: TAB_BAR };
    };
    const t = setTimeout(async () => {
      const sp = s.spot;
      const rect = !sp
        ? null
        : 'buddy' in sp
          ? { x: W - 16 - 64, y: H - insets.bottom - TAB_BAR - 16 - 64, w: 64, h: 64 }
          : 'target' in sp
            ? ((await measure(sp.target)) ?? tabRect(sp.tab))
            : tabRect(sp.tab);
      if (live) setSpot(rect);
    }, 420);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [on, step, s, W, H, insets.bottom]);

  // 밝힌 자리: 없으면 화면 가운데 점으로 오므라든다
  const box = spot
    ? { x: spot.x - PAD, y: spot.y - PAD, w: spot.w + PAD * 2, h: spot.h + PAD * 2 }
    : { x: W / 2, y: H / 2, w: 0, h: 0 };
  const x = useSharedValue(box.x);
  const y = useSharedValue(box.y);
  const w = useSharedValue(box.w);
  const h = useSharedValue(box.h);
  useSpring(x, box.x);
  useSpring(y, box.y);
  useSpring(w, box.w);
  useSpring(h, box.h);
  const dim = useAnimatedProps(() => ({ d: hole(W, H, x.get(), y.get(), w.get(), h.get()) }));
  const ring = useAnimatedStyle(() => ({
    left: x.get(),
    top: y.get(),
    width: w.get(),
    height: h.get(),
    opacity: w.get() > 4 ? 1 : 0,
  }));

  // 설명 카드: 밝힌 자리가 아래쪽이면 위로, 아니면 아래로 비켜 선다
  const below = !spot || spot.y + spot.h / 2 < H * 0.55;
  const cardAt = useSharedValue(0);
  useEffect(() => {
    cardAt.set(withTiming(below ? 1 : 0, { duration: 260, reduceMotion: R }));
  }, [below, cardAt]);
  const [cardH, setCardH] = useState(0);
  const card = useAnimatedStyle(() => {
    const top = insets.top + 56;
    const bottom = H - insets.bottom - TAB_BAR - 16 - cardH;
    return { top: top + (bottom - top) * cardAt.get() };
  });

  // 단계가 바뀌면 잠깐 말하고 멈춘다
  const [quiet, setQuiet] = useState(-1);
  useEffect(() => {
    const t = setTimeout(() => setQuiet(step), 1800);
    return () => clearTimeout(t);
  }, [step]);
  const mood: Mood = quiet === step ? 'idle' : 'talking';

  if (!on) return null;
  const done = async (to?: Href) => {
    go(-1);
    setSpot(null);
    if (userId) await rememberToured(userId);
    if (to) router.navigate(to);
  };

  return (
    <View className="absolute inset-0" accessibilityViewIsModal>
      <Svg width={W} height={H} style={{ position: 'absolute' }} pointerEvents="none">
        <AnimatedPath animatedProps={dim} fill="rgba(20,24,22,0.62)" fillRule="evenodd" />
      </Svg>
      <Animated.View
        pointerEvents="none"
        className="absolute rounded-2xl border-2 border-white"
        style={ring}
      />
      <Animated.View
        className="absolute inset-x-4 rounded-card bg-white p-4"
        style={card}
        onLayout={(e) => setCardH(e.nativeEvent.layout.height)}
      >
        <View className="flex-row items-start gap-3">
          <View className="h-14 w-14 items-center justify-center overflow-hidden rounded-full bg-mint">
            <Avatar3D mood={mood} avatarId={avatar} size={52} framing="head" />
          </View>
          <View className="flex-1">
            {/* 정리 → 학습 → 복습: 지금 설명하는 단계가 채워진다 */}
            <View className="mb-1.5 flex-row items-center gap-1">
              {FLOW.map((f, n) => (
                <View key={f} className="flex-row items-center gap-1">
                  {n > 0 && <Text className="text-caption2 text-sub">→</Text>}
                  <View
                    className={cx(
                      'rounded-full px-2 py-0.5',
                      s.flow === n ? 'bg-brand' : 'bg-fill',
                    )}
                  >
                    <Text
                      className={cx(
                        'text-caption2 font-semibold',
                        s.flow === n ? 'text-white' : 'text-sub',
                      )}
                    >
                      {f}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
            <Swap k={step}>
              <View className="gap-1">
                <Text className="text-headline font-bold text-ink">{s.title}</Text>
                <Text className="text-footnote leading-5 text-sub">{s.body}</Text>
              </View>
            </Swap>
          </View>
        </View>
        <View className="mt-4 flex-row items-center gap-2">
          <Text className="flex-1 text-caption text-sub">
            {step + 1} / {STEPS.length}
          </Text>
          {!last && (
            <Btn small kind="ghost" onPress={() => setSkip(true)}>
              건너뛰기
            </Btn>
          )}
          <Btn small onPress={() => (last ? void done('/note') : go(step + 1))}>
            {last ? '첫 학습 폴더 만들기' : '다음'}
          </Btn>
        </View>
      </Animated.View>
      <Alert
        open={skip}
        tone="brand"
        icon="?"
        title="안내를 건너뛰시겠습니까?"
        body="아바타 선생님은 정리된 노트에서 언제든 다시 만날 수 있어요."
        primary="건너뛰기"
        secondary="계속 보기"
        onPrimary={() => {
          setSkip(false);
          void done();
        }}
        onSecondary={() => setSkip(false)}
      />
    </View>
  );
}
