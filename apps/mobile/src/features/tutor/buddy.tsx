import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { router, useFocusEffect } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Text } from '@/components/text';
import { api } from '@/lib/api';
import { C } from '@/theme';
import { Avatar3D } from './avatar3d';

/** 장착한 상점 아바타 id(없으면 기본). 상점에서 장착을 바꾸면 ['my-items']가 새로 고쳐져 모양이 바뀐다 */
export function useEquippedAvatar() {
  // 상점을 못 불러와도 기본 아바타로 그린다(조회 안에서 읽어 렌더링을 막지 않게)
  const mine = useQuery({ queryKey: ['my-items'], queryFn: () => api.shop.myItems() });
  return mine.data?.find((u) => u.isEquipped && u.itemCategory === 'avatar')?.itemId ?? 'base';
}

/**
 * 읽는 동안 비켜 서기: 아래로 스크롤하면 숨고, 위로 올리거나 잠시 멈추면 다시 나온다.
 * 바뀔 때만 상태를 고친다(스크롤마다 다시 그리지 않음)
 */
export function useTuckOnScroll(restMs = 1200) {
  const [tucked, setTucked] = useState(false);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = e.nativeEvent.contentOffset.y;
      const dy = y - last.current;
      last.current = y;
      clearTimeout(timer.current);
      if (dy > 4 && y > 24) setTucked(true);
      else if (dy < -4) setTucked(false);
      timer.current = setTimeout(() => setTucked(false), restMs);
    },
    [restMs],
  );
  return { tucked, onScroll };
}

const SIZE = 64;
const PEEK = 18; // 숨었을 때 화면에 남기는 폭
const OFF = SIZE + 24; // 화면 밖(들어오기 전)
const R = ReduceMotion.System;
// 출발은 빠르게, 도착은 살짝 넘었다 돌아오게(작은 표현용 물체만 튕긴다: stageshow motion.md)
const TRAVEL = { duration: 460, dampingRatio: 0.62, reduceMotion: R };
const SNAP = Easing.bezier(0.3, 0.75, 0.1, 1);

/**
 * 노트 상세에 떠 있는 아바타 선생님. 화면 오른쪽 아래(아래 버튼 위)에 있다가, 읽는 동안에는
 * 가장자리로 "슉" 비켜 서고, 누르면 대화 화면을 연다. 다른 화면이 위에 있으면 3D를 그리지 않는다.
 */
export function TutorBuddy({ id, tucked }: { id: string; tucked: boolean }) {
  const avatar = useEquippedAvatar();
  const [focused, setFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  const [hint, setHint] = useState(true);

  const x = useSharedValue(OFF);
  const sx = useSharedValue(1);
  const tilt = useSharedValue(0);
  const press = useSharedValue(1);
  const first = useRef(true);
  // 얼굴을 그린 뒤에 들어온다(빈 원판만 날아오지 않게). GL이 늦으면 1.5초 뒤에는 그냥 들어온다
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 1500);
    return () => clearTimeout(t);
  }, []);
  // 들어온 뒤 잠깐 말풍선으로 할 일을 알려 준다
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => setHint(false), 3500);
    return () => clearTimeout(t);
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    const to = tucked ? SIZE - PEEK : 0;
    const dir = to > x.get() ? 1 : -1;
    // 들어올 때는 화면 전환이 끝난 뒤에
    const wait = first.current ? 150 : 0;
    first.current = false;
    x.set(withDelay(wait, withSpring(to, TRAVEL)));
    // 이동 방향으로 늘어났다가(속도감) 제 모양으로
    sx.set(
      withDelay(
        wait,
        withSequence(
          withTiming(1.16, { duration: 120, easing: SNAP, reduceMotion: R }),
          withSpring(1, { duration: 420, dampingRatio: 0.5, reduceMotion: R }),
        ),
      ),
    );
    // 가는 쪽으로 몸을 기울였다가 도착하며 반대로 살짝 흔들림
    tilt.set(
      withDelay(
        wait,
        withSequence(
          withTiming(dir * 14, { duration: 140, easing: SNAP, reduceMotion: R }),
          withSpring(tucked ? -dir * 8 : 0, { duration: 520, dampingRatio: 0.45, reduceMotion: R }),
        ),
      ),
    );
  }, [ready, tucked, x, sx, tilt]);

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.get() },
      { rotate: `${tilt.get()}deg` },
      { scaleX: sx.get() * press.get() },
      { scaleY: (2 - sx.get()) * press.get() },
    ],
  }));

  return (
    <View pointerEvents="box-none" className="absolute right-4 bottom-4 flex-row items-center">
      {hint && ready && !tucked && (
        <Animated.View
          entering={FadeIn.delay(700).duration(220)}
          exiting={FadeOut.duration(160)}
          className="mr-2 rounded-full bg-ink px-3 py-1.5"
          pointerEvents="none"
        >
          <Text className="text-caption font-semibold text-white">노트를 물어보세요</Text>
        </Animated.View>
      )}
      <Animated.View style={style}>
        <View
          // 그림자는 바깥에, 둥글게 자르기는 안쪽에(iOS는 overflow-hidden이 그림자를 자른다)
          className="rounded-full"
          style={{
            shadowColor: C.ink,
            shadowOpacity: 0.18,
            shadowRadius: 10,
            shadowOffset: { width: 0, height: 4 },
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="아바타 선생님에게 물어보기"
            hitSlop={8}
            onPressIn={() => press.set(withTiming(0.9, { duration: 100, reduceMotion: R }))}
            onPressOut={() =>
              press.set(withSpring(1, { duration: 300, dampingRatio: 0.6, reduceMotion: R }))
            }
            onPress={() => router.push({ pathname: '/tutor/[id]', params: { id } })}
            className="items-center justify-center overflow-hidden rounded-full border-2 border-white bg-mint"
            style={{ width: SIZE, height: SIZE }}
          >
            {focused && (
              <Avatar3D
                mood="idle"
                avatarId={avatar}
                size={SIZE - 4}
                framing="head"
                onReady={() => setReady(true)}
              />
            )}
          </Pressable>
        </View>
      </Animated.View>
    </View>
  );
}
