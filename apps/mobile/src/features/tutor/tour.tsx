import { useEffect, useState } from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import {
  BookOpenCheck,
  MessageCircleQuestion,
  NotebookPen,
  type LucideIcon,
} from 'lucide-react-native';
import { Text } from '@/components/text';
import { Alert, Btn, Canvas, Screen, Swap, cx } from '@/components/ui';
import { useAuth } from '@/stores/auth';
import { C, ICON } from '@/theme';
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

/** 가입을 마치고 처음 들어오면 한 번 안내를 연다(탭 화면에서 부름) */
export function useTourOnce(ready: boolean) {
  const userId = useAuth((s) => s.userId);
  useEffect(() => {
    if (!ready || !userId) return;
    let live = true;
    void touredIds().then((ids) => {
      if (live && !ids.includes(userId)) router.push('/tour');
    });
    return () => {
      live = false;
    };
  }, [ready, userId]);
}

type Step = { title: string; body: string; at: number | null };
/** at: 흐름 칸(정리 0 · 학습 1 · 복습 2) 위로 아바타가 옮겨 간다. null이면 가운데 */
export const STEPS: Step[] = [
  {
    title: '안녕하세요, 아바타 선생님이에요',
    body: '제가 NoteLink에서 공부를 정리 → 학습 → 복습으로 자연스럽게 이어 드릴게요.',
    at: null,
  },
  {
    title: '① 정리',
    body: '강의를 녹음하거나 필기 사진 · 문서를 올리면, 제가 AI로 핵심을 정리해 노트로 만들어 드려요.',
    at: 0,
  },
  {
    title: '② 학습',
    body: '정리된 노트에서 저를 누르면 궁금한 걸 물어볼 수 있어요. 노트와 퀴즈에 있는 내용으로만 설명해 드려요.',
    at: 1,
  },
  {
    title: '③ 복습',
    body: '노트로 퀴즈를 만들어 풀고, 틀린 문제는 복습으로 다시 풀어요. 맞히면 칭찬하고, 틀려도 끝까지 응원할게요.',
    at: 2,
  },
  {
    title: '이제 시작해 볼까요?',
    body: '공부 시간은 홈의 타이머로 재고, 친구와 스터디룸에서 함께할 수도 있어요. 첫 노트부터 만들어 봐요.',
    at: null,
  },
];
const FLOW: [string, LucideIcon][] = [
  ['정리', NotebookPen],
  ['학습', MessageCircleQuestion],
  ['복습', BookOpenCheck],
];

const R = ReduceMotion.System;
const SNAP = Easing.bezier(0.3, 0.75, 0.1, 1);
const SIZE = 150;

/**
 * 처음 안내: 아바타가 기능과 전체 흐름(정리 → 학습 → 복습)을 단계마다 설명한다. 흐름을 말할 때는
 * 그 칸 위로 "슉" 옮겨 가고(가는 쪽으로 기울었다가 살짝 튕기며 멈춤), 처음 · 끝은 가운데에 선다.
 * 아래 '건너뛰기'는 한 번 더 묻는다.
 */
export function TourScreen() {
  const userId = useAuth((s) => s.userId);
  const avatar = useEquippedAvatar();
  const [i, setI] = useState(0);
  const [skip, setSkip] = useState(false);
  const [w, setW] = useState(0);
  const step = STEPS[i]!;
  const last = i === STEPS.length - 1;

  // 단계가 바뀌면 잠깐 말하고 멈춘다
  const [quiet, setQuiet] = useState(-1);
  useEffect(() => {
    const t = setTimeout(() => setQuiet(i), 1800);
    return () => clearTimeout(t);
  }, [i]);
  const mood: Mood = quiet === i ? 'idle' : 'talking';

  const x = useSharedValue(0);
  const tilt = useSharedValue(0);
  const scale = useSharedValue(1);
  useEffect(() => {
    if (!w) return;
    const col = w / 3;
    const to = step.at == null ? 0 : col * step.at + col / 2 - w / 2;
    const dir = Math.sign(to - x.get()) || 0;
    x.set(withSpring(to, { duration: 520, dampingRatio: 0.66, reduceMotion: R }));
    tilt.set(
      withSequence(
        withTiming(dir * 12, { duration: 140, easing: SNAP, reduceMotion: R }),
        withSpring(0, { duration: 560, dampingRatio: 0.45, reduceMotion: R }),
      ),
    );
    scale.set(
      withSpring(step.at == null ? 1 : 0.72, { duration: 560, dampingRatio: 0.8, reduceMotion: R }),
    );
  }, [step.at, w, x, tilt, scale]);
  const fly = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }, { rotate: `${tilt.get()}deg` }, { scale: scale.get() }],
  }));

  const done = async (to?: '/note') => {
    if (userId) await rememberToured(userId);
    router.back();
    if (to) router.push(to);
  };

  return (
    <Canvas>
      <Screen
        scroll={false}
        footer={
          <View className="gap-1">
            <Btn onPress={() => (last ? void done('/note') : setI(i + 1))}>
              {last ? '첫 노트 만들러 가기' : '다음'}
            </Btn>
            {last ? (
              <Btn kind="ghost" onPress={() => void done()}>
                둘러보기
              </Btn>
            ) : (
              <Btn kind="ghost" onPress={() => setSkip(true)}>
                건너뛰기
              </Btn>
            )}
          </View>
        }
      >
        <View
          className="mt-4 flex-row justify-center gap-1.5"
          accessibilityLabel={`${i + 1}/${STEPS.length}단계`}
        >
          {STEPS.map((_, n) => (
            <View
              key={n}
              className={cx('h-1.5 rounded-full', n === i ? 'w-5 bg-brand' : 'w-1.5 bg-line')}
            />
          ))}
        </View>
        <View
          className="mt-6 overflow-hidden rounded-card bg-mint pt-4 pb-3"
          onLayout={(e) => setW(e.nativeEvent.layout.width)}
        >
          <View className="items-center" style={{ height: SIZE }}>
            <Animated.View style={fly}>
              <Avatar3D mood={mood} avatarId={avatar} size={SIZE} />
            </Animated.View>
          </View>
          {/* 정리 → 학습 → 복습: 지금 설명하는 칸이 채워진다 */}
          <View className="mt-2 flex-row px-2">
            {FLOW.map(([label, Icon], n) => {
              const on = step.at === n;
              return (
                <View key={label} className="flex-1 items-center gap-1">
                  <View
                    className={cx(
                      'h-9 w-9 items-center justify-center rounded-full',
                      on ? 'bg-brand' : 'bg-white',
                    )}
                  >
                    <Icon size={ICON.sm} color={on ? '#fff' : C.sub} />
                  </View>
                  <Text
                    className={cx('text-caption font-semibold', on ? 'text-brand' : 'text-sub')}
                  >
                    {label}
                  </Text>
                </View>
              );
            })}
          </View>
        </View>
        <View className="mt-5">
          <Swap k={i}>
            <Animated.View entering={FadeIn.duration(180)} className="gap-2">
              <Text className="text-title3 font-bold text-ink">{step.title}</Text>
              <Text className="text-body leading-6 text-sub">{step.body}</Text>
            </Animated.View>
          </Swap>
        </View>
      </Screen>
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
    </Canvas>
  );
}
