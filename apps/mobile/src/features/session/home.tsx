import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/text';
import { router, useFocusEffect } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useKeepAwake } from 'expo-keep-awake';
import { Accelerometer } from 'expo-sensors';
import * as Haptics from 'expo-haptics';
import { Pause, Play, Square, Target, Users } from 'lucide-react-native';
import { api } from '@/lib/api';
import { dLabel, goalLabel, hm, hms, seoul, ymd } from '@/lib/dates';
import { useNow } from '@/hooks';
import { useAuth } from '@/stores/auth';
import { toast } from '@/stores/toast';
import { AUTO_END_MS, useSession } from '@/stores/session';
import { Badge, Btn, Card, Dashed, Screen, cx } from '@/components/ui';
import { C, ICON } from '@/theme';
import { AddItemSheet, WeekGoalSheet } from './sheets';
import { useFeatureNavigation } from '@/lib/feature-navigation';
import { NetBanner } from '@/components/NetBanner';

// p.46~49 홈 · 공부 측정

export function HomeScreen() {
  const qc = useQueryClient();
  const openFeature = useFeatureNavigation();
  const now = useNow();
  const day = ymd(seoul(now));
  const today = useQuery({ queryKey: ['study', 'today', day], queryFn: api.study.today });
  const weekly = useQuery({ queryKey: ['study', 'weekly', day], queryFn: api.study.weekly });
  const goal = useQuery({ queryKey: ['goal', 'weekly', day], queryFn: api.study.weeklyGoal });
  const ddays = useQuery({ queryKey: ['ddays'], queryFn: api.calendar.ddays });
  const me = useQuery({ queryKey: ['me'], queryFn: api.me.get });
  const s = useSession();
  const running = !!s.since;
  const [sheet, setSheet] = useState<null | 'add' | 'goal'>(null);

  const items = today.data?.items ?? [];
  const has = items.length > 0;
  const active =
    items.find((i) => i._id === s.itemId) ??
    (s.itemId ? { _id: s.itemId, title: '진행 중인 공부', subjectName: '' } : undefined);
  const midnight = Date.parse(`${day}T00:00:00+09:00`);
  const weekday = new Date(midnight + 9 * 3600000).getUTCDay();
  const monday = midnight - ((weekday + 6) % 7) * 86400000;
  const dayLive = s.itemId ? s.elapsedSince(midnight, now) : 0;
  const live = (id: string, base: number) => base + (id === s.itemId ? dayLive : 0);
  const todaySec = items.reduce((a, i) => a + i.accumulatedSec, 0) + dayLive;
  const weekSec = (weekly.data?.totalSec ?? 0) + (s.itemId ? s.elapsedSince(monday, now) : 0);
  const goalMin = goal.data?.targetMin ?? 21 * 60;
  const pct = Math.round((weekSec / 60 / goalMin) * 100);
  const nextDday = ddays.data?.find((d) => d.daysLeft >= 0);

  const toggle = async (id: string) => {
    Haptics.selectionAsync();
    if (s.itemId === id && running) return s.pause();
    // 다른 항목으로 바꾸면 start()가 앞 세션을 끝낸다 → 서버 누적을 다시 받아 방금 공부한 시간이 빠지지 않게
    const switching = !!s.itemId && s.itemId !== id;
    try {
      await s.start(id);
      if (switching) await qc.invalidateQueries({ queryKey: ['study'] });
    } catch {
      toast('공부를 시작하지 못했어요. 연결을 확인하고 다시 시도해주세요');
    }
  };
  const ending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const finish = async (reason = 'manual') => {
    if (ending.current) return;
    ending.current = true;
    const owner = useAuth.getState().userId;
    let valid = true;
    const stopAuth = useAuth.subscribe((next, previous) => {
      if (next.userId !== previous.userId || (previous.tokens && !next.tokens)) valid = false;
    });
    const stopSession = useSession.subscribe((next) => {
      if (next.itemId && (next.itemId !== s.itemId || next.sessionId !== s.sessionId))
        valid = false;
    });
    const current = () =>
      valid &&
      mounted.current &&
      useAuth.getState().userId === owner &&
      useSession.getState().itemId === null;
    try {
      const r = await s.end(reason);
      if (!current()) return;
      await qc.invalidateQueries({ queryKey: ['study'] });
      if (!current()) return;
      router.push({
        pathname: '/summary',
        params: { sec: String(r.sec), points: String(r.pointsEarned) },
      });
    } catch {
      if (valid && mounted.current) toast('종료하지 못했어요. 연결을 확인하고 다시 종료해주세요');
    } finally {
      stopAuth();
      stopSession();
      ending.current = false;
    }
  };

  // 쉬는 중 10분이 지나면 자동 종료 (p.48)
  useEffect(() => {
    if (s.pausedAt && now - s.pausedAt > AUTO_END_MS) finish('auto_pause_timeout');
  }, [now]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View className="flex-1 bg-white">
      {running && <KeepAwake />}
      {s.itemId && <TiltWatcher />}
      <Screen>
        <NetBanner />
        <View className="flex-row items-start justify-between pt-4">
          <View>
            {has && <Text className="text-caption text-sub">안녕하세요</Text>}
            <Text className="text-title2 font-bold text-ink">
              {has
                ? `${me.data?.nickname ?? ''} 님 🔥 ${me.data?.streakDays ?? 0}일째`
                : '안녕하세요👋'}
            </Text>
            {!has && (
              <Text className="text-caption text-sub">노트링크와 함께 학습을 시작해보세요</Text>
            )}
          </View>
          <Pressable
            accessibilityLabel="친구"
            onPress={() => openFeature('/friends')}
            className="h-9 w-9 items-center justify-center rounded-full bg-mint"
          >
            <Users size={ICON.md} color={C.brand} />
          </Pressable>
        </View>

        {has && nextDday && (
          <Pressable
            onPress={() => openFeature('/dday')}
            className="mt-3 flex-row items-center gap-3 px-1 py-2"
          >
            <View className="h-9 w-9 items-center justify-center rounded-full bg-cream">
              <Target size={ICON.md} color={C.brand} />
            </View>
            <View className="flex-1">
              <Text className="text-subhead font-semibold text-ink">{nextDday.title}</Text>
              <Text className="text-caption text-sub">
                {nextDday.kind} · {nextDday.date.slice(5).replace('-', '월 ')}일
              </Text>
            </View>
            <Badge tone="sun">{dLabel(nextDday.daysLeft)}</Badge>
          </Pressable>
        )}

        {/* 순공시간 카드 */}
        <View className="mt-3 rounded-3xl bg-night p-5">
          <View className="flex-row items-center justify-between">
            <Text className="text-caption text-white/70">오늘 순공시간</Text>
            <View className="flex-row items-center gap-1">
              <View
                className={cx('h-1.5 w-1.5 rounded-full', running ? 'bg-sun' : 'bg-white/50')}
              />
              <Text className="text-caption text-white/70">
                {running ? '측정 중' : active ? '일시정지' : '측정 대기'}
              </Text>
            </View>
          </View>
          <Text className={cx('mt-1 text-footnote', running ? 'text-sun' : 'text-white/60')}>
            {active
              ? `${running ? '▶ ' : ''}${active.title} · ${active.subjectName}`
              : has
                ? '오늘 공부할 목록에서 항목을 고르세요'
                : '먼저 공부할 항목을 추가해 주세요'}
          </Text>
          <Text
            className="mt-1 tabular-nums text-display font-bold text-white"
            style={{ fontVariant: ['tabular-nums'] }}
          >
            {hms(active || todaySec ? todaySec : 0)}
          </Text>
          <Pressable accessibilityLabel="주간 목표 설정" onPress={() => setSheet('goal')}>
            <Text className="text-footnote text-white/80">
              {running
                ? `책상 앞이에요 · 이번주 목표 ${pct}%`
                : active
                  ? '쉬는 중 · 10분이 지나면 자동으로 종료돼요'
                  : has
                    ? `이번주 ${hm(weekSec)} / 목표 ${goalMin / 60}시간 (${pct}%) ›`
                    : `이번주 ${hm(weekSec)} / 목표 ${goalMin / 60}시간 (${pct}%) ›`}
            </Text>
          </Pressable>
          <Pressable onPress={() => active && router.push('/landscape')}>
            <Text className="mt-0.5 text-caption2 text-white/45">
              ⟳ 가로로 돌리면 자동 측정 · 세로로 세우면 정지
            </Text>
          </Pressable>
          {active ? (
            <View className="mt-4 flex-row gap-2">
              <View className="flex-1">
                {running ? (
                  <Btn
                    kind="gray"
                    small
                    icon={<Pause size={ICON.sm} color="#fff" />}
                    onPress={() => s.pause()}
                  >
                    일시정지
                  </Btn>
                ) : (
                  <Btn
                    kind="sun"
                    small
                    icon={<Play size={ICON.sm} color={C.ink} />}
                    onPress={() => s.resume()}
                  >
                    계속하기
                  </Btn>
                )}
              </View>
              <View className="flex-1">
                <Btn
                  kind={running ? 'sun' : 'gray'}
                  small
                  icon={<Square size={ICON.xs} color={running ? C.ink : '#fff'} />}
                  onPress={() => finish()}
                >
                  종료
                </Btn>
              </View>
            </View>
          ) : (
            <View className="mt-4 rounded-xl bg-white/5 py-2.5">
              <Text className="text-center text-caption text-white/70">
                {has
                  ? '아래 목록에서 ▶을 눌러 공부를 시작하세요'
                  : '항목을 추가하면 ▶로 바로 시작할 수 있어요'}
              </Text>
            </View>
          )}
        </View>

        <View className="mt-6 mb-2 flex-row items-center justify-between">
          <Text className="text-headline font-bold text-ink">오늘 공부할 목록</Text>
          <Text className="text-caption text-sub">{items.length}개</Text>
        </View>
        {!has && (
          <View className="items-center rounded-2xl border border-dashed border-cream-2 py-5">
            <Text className="text-footnote text-sub">아직 공부할 목록이 없어요</Text>
            <Text className="text-caption2 text-sub/80">
              과목이나 할 일을 추가하면 항목별로 시간을 따로 재요
            </Text>
          </View>
        )}
        <View className="gap-2">
          {items.map((it) => {
            const on = it._id === s.itemId;
            const play = on && running;
            return (
              <View
                key={it._id}
                className={cx(
                  'flex-row items-center gap-3 rounded-2xl border px-4 py-3',
                  on ? 'border-brand/40 bg-mint' : 'border-line bg-white',
                )}
              >
                <View className={cx('h-8 w-1 rounded-full', on ? 'bg-brand' : 'bg-cream-2')} />
                <View className="flex-1">
                  <Text className="text-callout font-semibold text-ink">{it.title}</Text>
                  <Text className="text-caption text-sub">
                    {it.subjectName} · 목표 {goalLabel(it.goalMin)}
                  </Text>
                </View>
                <Text className="tabular-nums text-subhead font-semibold text-ink/80">
                  {hms(live(it._id, it.accumulatedSec))}
                </Text>
                <Pressable
                  accessibilityLabel={`${it.title} ${play ? '일시정지' : '시작'}`}
                  onPress={() => toggle(it._id)}
                  className={cx(
                    'h-9 w-9 items-center justify-center rounded-full',
                    on ? 'bg-brand' : 'bg-mint',
                  )}
                >
                  {play ? (
                    <Pause size={ICON.sm} color="#fff" />
                  ) : (
                    <Play size={ICON.sm} color={on ? '#fff' : C.brand} />
                  )}
                </Pressable>
              </View>
            );
          })}
        </View>
        <Dashed onPress={() => setSheet('add')}>+ 공부할 항목 추가</Dashed>

        <Text className="mt-6 mb-2 text-headline font-bold text-ink">학습 기록</Text>
        <Card className="p-4" onPress={() => openFeature('/record')}>
          <View className="flex-row justify-between">
            <Text className="text-caption text-sub">이번주 순공시간</Text>
            <Text className="text-caption font-semibold text-brand">기록 · 캘린더 ›</Text>
          </View>
          <Text className="mt-1 text-title2 font-bold text-ink">{hm(weekSec)}</Text>
          <Text className="text-caption text-sub">
            {has
              ? `지난주보다 ${hm(Math.abs(weekly.data?.diffFromLastWeekSec ?? 0)).replace('0시간 ', '')} ${(weekly.data?.diffFromLastWeekSec ?? 0) < 0 ? '줄었어요' : '늘었어요'}`
              : '학습 기록이 쌓이면 스트릭이 시작돼요'}
          </Text>
        </Card>
      </Screen>
      <AddItemSheet open={sheet === 'add'} onClose={() => setSheet(null)} />
      <WeekGoalSheet open={sheet === 'goal'} onClose={() => setSheet(null)} />
    </View>
  );
}

function KeepAwake() {
  useKeepAwake('study-timer');
  return null;
}

/** 기기를 가로로 눕히면 자동 측정 화면으로 (p.49 #8, 기기 기울기 센서) */
function TiltWatcher() {
  const pushed = useRef(false);
  useFocusEffect(
    useCallback(() => {
      pushed.current = false;
      Accelerometer.setUpdateInterval(400);
      const sub = Accelerometer.addListener(({ x, y }) => {
        if (!pushed.current && Math.abs(x) > 0.8 && Math.abs(y) < 0.35) {
          pushed.current = true;
          router.push('/landscape');
        }
      });
      return () => sub.remove();
    }, []),
  );
  return null;
}
