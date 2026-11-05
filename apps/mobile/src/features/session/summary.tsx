import { useEffect, useRef } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/text';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Accelerometer } from 'expo-sensors';
import * as ScreenOrientation from 'expo-screen-orientation';
import { Mic, PartyPopper, PenLine, X } from 'lucide-react-native';
import { api } from '@/lib/api';
import { useFeatureNavigation } from '@/lib/feature-navigation';
import { diffLabel, goalLabel, hm, hms, seoul, ymd, today as seoulToday } from '@/lib/dates';
import { useNow } from '@/hooks';
import { useSession } from '@/stores/session';
import { toast } from '@/stores/toast';
import { Btn, Card, Progress, Screen } from '@/components/ui';
import { C, ICON } from '@/theme';

// p.48 #6 공부 종료 요약

export function SummaryScreen() {
  const openFeature = useFeatureNavigation();
  const { sec, points } = useLocalSearchParams<{ sec?: string; points?: string }>();
  const today = useQuery({ queryKey: ['study', 'today', seoulToday()], queryFn: api.study.today });
  const weekly = useQuery({
    queryKey: ['study', 'weekly', seoulToday()],
    queryFn: api.study.weekly,
  });
  const goal = useQuery({
    queryKey: ['goal', 'weekly', seoulToday()],
    queryFn: api.study.weeklyGoal,
  });
  const me = useQuery({ queryKey: ['me'], queryFn: api.me.get });
  const items = today.data?.items ?? [];
  const total = items.reduce((a, i) => a + i.accumulatedSec, 0);
  const done = items.filter((i) => i.goalMin && i.accumulatedSec >= i.goalMin * 60).length;
  const goalMin = goal.data?.targetMin ?? 1260;
  const pct = Math.round(((weekly.data?.totalSec ?? 0) / 60 / goalMin) * 100);
  useEffect(() => {
    if (Number(points) > 0) toast(`순공 세션 완료 +${points}P`);
  }, [points]);
  const home = () => router.dismissTo('/');
  return (
    <Screen
      footer={
        <>
          <Btn onPress={home}>홈으로</Btn>
          <Pressable onPress={() => openFeature('/record', 'replace')} className="mt-2">
            <Text className="text-center text-footnote text-brand">학습 기록 보기 ›</Text>
          </Pressable>
        </>
      }
    >
      <View className="items-end pt-3">
        <Pressable accessibilityLabel="닫기" onPress={home} hitSlop={10}>
          <X size={ICON.md} color={C.sub} />
        </Pressable>
      </View>
      <View className="items-center">
        <PartyPopper size={ICON.xl} color={C.brand} />
        <Text className="text-title3 font-bold text-ink">수고했어요, {me.data?.nickname} 님</Text>
        <Text className="text-caption text-sub">
          오늘 순공시간{sec ? ` · 이번 세션 ${hm(Number(sec))}` : ''}
        </Text>
        <Text className="tabular-nums text-large font-bold text-brand">{hms(total)}</Text>
      </View>
      <Card className="mt-4 p-4">
        <View className="flex-row justify-between">
          <Text className="text-footnote font-semibold text-ink">항목별 목표</Text>
          <Text className="text-footnote text-brand">
            {items.length}개 중 {done}개 달성
          </Text>
        </View>
        {items.map((i) => (
          <View key={i._id} className="mt-3">
            <View className="flex-row justify-between">
              <Text className="text-footnote text-ink">
                {i.title} · {i.subjectName}
              </Text>
              <Text className="text-footnote text-ink">
                <Text className="font-bold">{Math.floor(i.accumulatedSec / 60)}분</Text>
                <Text className="text-sub">
                  {' '}
                  / {goalLabel(i.goalMin)}
                  {i.goalMin && i.accumulatedSec >= i.goalMin * 60 ? ' ✓' : ''}
                </Text>
              </Text>
            </View>
            <Progress
              value={i.goalMin ? (i.accumulatedSec / (i.goalMin * 60)) * 100 : 0}
              className="mt-1.5"
            />
          </View>
        ))}
      </Card>
      <View className="mt-4 flex-row justify-between">
        <Text className="text-subhead font-semibold text-ink">이번주 목표 {goalMin / 60}시간</Text>
        <Text className="text-subhead font-semibold text-brand">{pct}%</Text>
      </View>
      <Progress value={pct} className="mt-1.5" />
      <Text className="mt-1 text-caption text-sub">
        {hm(weekly.data?.totalSec ?? 0)} · {diffLabel(weekly.data?.diffFromLastWeekSec ?? 0)}
      </Text>
      <Card tone="white" className="mt-4 p-4">
        <Text className="text-subhead font-semibold text-ink">오늘 공부를 노트로 남겨둘까요?</Text>
        <Text className="text-caption text-sub">
          올린 필기·녹음은 오늘 공부한 시간과 함께 기록돼요
        </Text>
        <View className="mt-3 flex-row gap-2">
          <Card
            tone="mint"
            className="flex-1 items-center py-3"
            onPress={() =>
              openFeature(
                { pathname: '/(tabs)/note', params: { upload: 'hand' } },
                'navigate',
                '/capture/camera',
              )
            }
          >
            <PenLine size={ICON.md} color={C.brand} />
            <Text className="text-footnote font-semibold text-ink">필기 사진</Text>
            <Text className="text-caption2 text-sub">촬영 · 갤러리</Text>
          </Card>
          <Card
            tone="mint"
            className="flex-1 items-center py-3"
            onPress={() =>
              openFeature(
                { pathname: '/(tabs)/note', params: { upload: 'rec' } },
                'navigate',
                '/capture/rec-upload',
              )
            }
          >
            <Mic size={ICON.md} color={C.brand} />
            <Text className="text-footnote font-semibold text-ink">녹음</Text>
            <Text className="text-caption2 text-sub">파일 · 실시간</Text>
          </Card>
        </View>
      </Card>
    </Screen>
  );
}

/** p.49 #8 가로로 돌리면 자동 측정 — 세로로 세우면 측정을 멈추고 돌아간다 */
export function LandscapeScreen() {
  const s = useSession();
  const now = useNow();
  const day = ymd(seoul(now));
  const midnight = Date.parse(`${day}T00:00:00+09:00`);
  const today = useQuery({ queryKey: ['study', 'today', day], queryFn: api.study.today });
  const active = today.data?.items.find((i) => i._id === s.itemId);
  // 지금 공부하는 항목의 오늘 시간 (다른 항목 시간은 더하지 않는다)
  const total = (active?.accumulatedSec ?? 0) + s.elapsedSince(midnight, now);
  const leaving = useRef(false);
  const exit = () => {
    if (leaving.current) return;
    leaving.current = true;
    s.pause();
    router.back();
  };
  useEffect(() => {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
    // 이전 화면의 정지 요청이 대기 중이어도 마지막 가로 진입 의도를 전달한다.
    if (s.itemId) void s.resume();
    Accelerometer.setUpdateInterval(400);
    const sub = Accelerometer.addListener(({ y }) => Math.abs(y) > 0.8 && exit());
    return () => {
      sub.remove();
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Pressable onPress={exit} className="flex-1 items-center justify-center bg-black px-10">
      <View className="absolute top-8 left-10 flex-row items-center gap-1.5">
        <View
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: s.since ? C.sun : C.sub }}
        />
        <Text className="text-footnote text-white">
          {s.since ? '자동 측정 중' : s.sessionId ? '일시정지' : '측정 시작 대기'}
        </Text>
      </View>
      <Text className="text-body font-semibold text-white">
        {active ? `${active.title} · ${active.subjectName}` : '순공시간'}
      </Text>
      <Text
        className="tabular-nums text-timer font-bold text-orange"
        style={{ fontVariant: ['tabular-nums'] }}
      >
        {hms(total)}
      </Text>
      <Text className="absolute bottom-8 text-caption text-white/60">
        세로로 돌리면 측정을 멈춰요
      </Text>
    </Pressable>
  );
}
