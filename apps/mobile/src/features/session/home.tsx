import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/text';
import { router, useFocusEffect } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useKeepAwake } from 'expo-keep-awake';
import { Accelerometer } from 'expo-sensors';
import * as Haptics from 'expo-haptics';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { Flame, Pause, Play, Plus, RotateCw, Square, Target, Users } from 'lucide-react-native';
import { api } from '@/lib/api';
import { dLabel, goalLabel, hm, hms, seoul, ymd } from '@/lib/dates';
import { useNow } from '@/hooks';
import { useAuth } from '@/stores/auth';
import { toast } from '@/stores/toast';
import { AUTO_END_MS, useSession } from '@/stores/session';
import {
  Badge,
  Btn,
  Canvas,
  Card,
  LIST_LAYOUT,
  Progress,
  Roll,
  Screen,
  Swap,
  Tap,
  cx,
} from '@/components/ui';
import { C, ICON, MOTION, SHADOW } from '@/theme';
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
  // 큰 타이머는 지금 공부하는 항목의 시간만 보여 준다 (다른 항목 시간이 이어 붙지 않게)
  const activeSec = s.itemId
    ? live(s.itemId, items.find((i) => i._id === s.itemId)?.accumulatedSec ?? 0)
    : null;
  const weekSec = (weekly.data?.totalSec ?? 0) + (s.itemId ? s.elapsedSince(monday, now) : 0);
  // 목표를 읽지 못했으면 임의의 목표로 계산하지 않는다
  const goalMin = goal.data?.targetMin;
  // 주간 기록을 못 읽었으면 0시간이나 0%로 표시하지 않는다
  const pct = goalMin && weekly.data ? Math.round((weekSec / 60 / goalMin) * 100) : null;
  const weekLabel = weekly.data
    ? `이번주 ${hm(weekSec)}${goalMin ? ` / 목표 ${goalMin / 60}시간 (${pct}%)` : ''} ›`
    : '주간 목표 설정 ›';
  const nextDday = ddays.data?.find((d) => d.daysLeft >= 0);

  const toggle = async (id: string) => {
    Haptics.selectionAsync();
    if (s.itemId === id && running) return s.pause();
    // 다른 항목으로 바꾸면 start()가 앞 세션을 끝낸다 → 서버 누적을 다시 받아 방금 공부한 시간이 빠지지 않게
    const switching = !!s.itemId && s.itemId !== id;
    const owner = useAuth.getState().userId;
    try {
      await s.start(id);
    } catch {
      if (useAuth.getState().userId === owner)
        toast('공부를 시작하지 못했어요. 연결을 확인하고 다시 시도해주세요');
    } finally {
      if (switching && useAuth.getState().userId === owner)
        await qc.invalidateQueries({ queryKey: ['study'] });
    }
  };
  const ending = useRef(false);
  // 다른 화면을 보는 중이면 자동 종료로 화면을 끌고 가지 않는다
  const focused = useRef(true);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      return () => {
        focused.current = false;
      };
    }, []),
  );
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
      if (reason === 'auto_pause_timeout' && !focused.current)
        toast('쉬는 시간이 길어져 공부 측정을 자동으로 끝냈어요');
      else
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

  // 같은 휴식의 자동 종료는 한 번만 요청한다. 실패 후에는 화면의 종료 버튼으로 재시도한다.
  const attemptedAutoEnd = useRef<string | null>(null);
  useEffect(() => {
    if (!s.pausedAt || now - s.pausedAt <= AUTO_END_MS) return;
    const key = `${s.sessionId}:${s.pausedAt}`;
    if (attemptedAutoEnd.current === key) return;
    attemptedAutoEnd.current = key;
    void finish('auto_pause_timeout');
  }, [now, s.pausedAt, s.sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const status = running ? '측정 중' : active ? '일시정지' : '측정 대기';
  return (
    <Canvas>
      {running && <KeepAwake />}
      <TiltWatcher />
      <Screen>
        <NetBanner />
        <View className="flex-row items-start justify-between pt-5">
          <View className="flex-1">
            {has && <Text className="text-caption text-sub">안녕하세요</Text>}
            <View className="flex-row items-center gap-2">
              <Text className="text-title2 font-bold text-ink">
                {has ? `${me.data?.nickname ?? ''} 님` : '안녕하세요'}
              </Text>
              {has && (
                <View className="flex-row items-center gap-1 rounded-full bg-sun/20 px-2 py-0.5">
                  <Flame size={ICON.xs} color={C.ink} />
                  <Text className="text-caption font-semibold text-ink">
                    {me.data?.streakDays ?? 0}일째
                  </Text>
                </View>
              )}
            </View>
            {!has && (
              <Text className="text-caption text-sub">노트링크와 함께 학습을 시작해보세요</Text>
            )}
          </View>
          <Pressable
            accessibilityLabel="친구"
            onPress={() => openFeature('/friends')}
            className="h-11 w-11 items-center justify-center rounded-full bg-white"
          >
            <Users size={ICON.md} color={C.brand} />
          </Pressable>
        </View>

        {has && nextDday && (
          <Pressable
            onPress={() => openFeature('/dday')}
            className="mt-4 flex-row items-center gap-3 px-1 py-2"
          >
            <View className="h-9 w-9 items-center justify-center rounded-full bg-white">
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

        {/* 집중 카드: 화면에서 그림자를 쓰는 하나뿐인 면. 측정을 시작하면 버튼 줄이 열리며 아래가 함께 밀린다 */}
        <Animated.View
          layout={LIST_LAYOUT}
          className="mt-6 rounded-card bg-night p-6"
          style={{ boxShadow: SHADOW.focus }}
        >
          <View className="flex-row items-center justify-between">
            <Text className="text-caption text-white/70">
              {active ? '이 항목 오늘 공부 시간' : '오늘 순공시간'}
            </Text>
            <View className="flex-row items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1">
              <View
                className={cx('h-1.5 w-1.5 rounded-full', running ? 'bg-sun' : 'bg-white/50')}
              />
              <Swap k={status}>
                <Text className={cx('text-caption', running ? 'text-sun' : 'text-white/70')}>
                  {status}
                </Text>
              </Swap>
            </View>
          </View>
          {(active || !has) && (
            <Text className={cx('mt-1 text-footnote', running ? 'text-sun' : 'text-white/60')}>
              {active
                ? `${active.title} · ${active.subjectName}`
                : '먼저 공부할 항목을 추가해 주세요'}
            </Text>
          )}
          <View className="mt-1">
            <Roll
              value={hms(activeSec ?? todaySec)}
              className={cx(
                'text-display font-bold',
                active && !running ? 'text-white/50' : 'text-white',
              )}
            />
          </View>
          {active && <Text className="text-caption text-white/60">오늘 전체 {hms(todaySec)}</Text>}
          <Pressable
            accessibilityLabel="주간 목표 설정"
            onPress={() => setSheet('goal')}
            className="mt-4"
          >
            <Text className="text-footnote text-white/80">
              {running
                ? `책상 앞이에요${pct === null ? '' : ` · 이번주 목표 ${pct}%`}`
                : active
                  ? '쉬는 중 · 10분이 지나면 자동으로 종료돼요'
                  : weekLabel}
            </Text>
            {pct !== null && <Progress value={pct} tone="sun" onDark className="mt-2" />}
          </Pressable>
          {active && (
            <Animated.View
              entering={FadeIn.duration(MOTION.enter)}
              exiting={FadeOut.duration(MOTION.exit)}
            >
              <Pressable
                onPress={() => router.push('/landscape')}
                className="mt-3 flex-row items-center gap-1"
              >
                <RotateCw size={ICON.xs} color={C.sub} />
                <Text className="text-caption2 text-white/45">
                  가로로 돌리면 자동 측정 · 세로로 세우면 정지
                </Text>
              </Pressable>
              <View className="mt-6 flex-row gap-3">
                <View className="flex-1">
                  <Swap k={running ? 'pause' : 'resume'}>
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
                  </Swap>
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
            </Animated.View>
          )}
        </Animated.View>

        <Animated.View layout={LIST_LAYOUT}>
          <View className="mt-10 mb-4 flex-row items-center justify-between px-1">
            <Text className="text-headline font-bold text-ink">오늘 공부할 목록</Text>
            <Text className="text-caption text-sub">{items.length}개</Text>
          </View>
          {today.isError && !today.data && (
            <View className="gap-2 py-3">
              <Text className="text-footnote text-sub">오늘 목록을 불러오지 못했어요</Text>
              <Btn small onPress={() => void today.refetch()}>
                오늘 목록 다시 시도
              </Btn>
            </View>
          )}
          {today.isSuccess && !has && (
            <View className="mb-3 items-center rounded-card bg-cream py-6">
              <Text className="text-footnote text-sub">아직 공부할 목록이 없어요</Text>
              <Text className="text-caption2 text-sub">
                과목이나 할 일을 추가하면 항목별로 시간을 따로 재요
              </Text>
            </View>
          )}
          {/* 목록은 흰 그룹 하나 — 항목을 더하거나 지우면 남은 행이 자리를 메운다 */}
          <View className="overflow-hidden rounded-card bg-white">
            {items.map((it, i) => {
              const on = it._id === s.itemId;
              const play = on && running;
              return (
                <Animated.View
                  key={it._id}
                  layout={LIST_LAYOUT}
                  entering={FadeIn.duration(MOTION.enter)}
                  exiting={FadeOut.duration(MOTION.exit)}
                  className={cx(
                    'flex-row items-center gap-3.5 px-5 py-4',
                    i > 0 && 'border-t border-fill',
                    on && 'bg-mint',
                  )}
                >
                  <View className={cx('h-8 w-1 rounded-full', on ? 'bg-brand' : 'bg-fill')} />
                  <View className="flex-1">
                    <Text className="text-callout font-semibold text-ink">{it.title}</Text>
                    <Text className="text-caption text-sub">
                      {it.subjectName} ·{' '}
                      {it.goalMin ? `목표 ${goalLabel(it.goalMin)}` : goalLabel(null)}
                    </Text>
                  </View>
                  <Text
                    className={cx(
                      'tabular-nums text-subhead font-semibold',
                      on ? 'text-brand' : 'text-ink/80',
                    )}
                  >
                    {hms(live(it._id, it.accumulatedSec))}
                  </Text>
                  <Pressable
                    accessibilityLabel={`${it.title} ${play ? '일시정지' : '시작'}`}
                    onPress={() => toggle(it._id)}
                    className={cx(
                      'h-11 w-11 items-center justify-center rounded-full',
                      on ? 'bg-brand' : 'bg-mint',
                    )}
                  >
                    <Swap k={play ? 'pause' : 'play'}>
                      {play ? (
                        <Pause size={ICON.sm} color="#fff" />
                      ) : (
                        <Play size={ICON.sm} color={on ? '#fff' : C.brand} />
                      )}
                    </Swap>
                  </Pressable>
                </Animated.View>
              );
            })}
            <Tap
              accessibilityRole="button"
              onPress={() => setSheet('add')}
              className={cx('flex-row items-center gap-3 px-5 py-4', has && 'border-t border-fill')}
            >
              <Plus size={ICON.md} color={C.brand} />
              <Text className="text-subhead font-semibold text-brand">공부할 항목 추가</Text>
            </Tap>
          </View>

          <Text className="mt-10 mb-4 px-1 text-headline font-bold text-ink">학습 기록</Text>
          <Card className="p-6" onPress={() => openFeature('/record')}>
            <View className="flex-row justify-between">
              <Text className="text-caption text-sub">이번주 순공시간</Text>
              <Text className="text-caption font-semibold text-brand">기록 · 캘린더 ›</Text>
            </View>
            <View className="mt-1">
              {weekly.data ? (
                <Roll value={hm(weekSec)} className="text-title2 font-bold text-ink" />
              ) : (
                <Text className="text-title2 font-bold text-ink">-</Text>
              )}
            </View>
            <Text className="text-caption text-sub">
              {weekly.isError && !weekly.data
                ? '이번주 기록을 불러오지 못했어요'
                : has
                  ? `지난주보다 ${hm(Math.abs(weekly.data?.diffFromLastWeekSec ?? 0)).replace('0시간 ', '')} ${(weekly.data?.diffFromLastWeekSec ?? 0) < 0 ? '줄었어요' : '늘었어요'}`
                  : '학습 기록이 쌓이면 스트릭이 시작돼요'}
            </Text>
            {weekly.isError && !weekly.data && (
              <Btn small className="mt-2" onPress={() => void weekly.refetch()}>
                이번주 기록 다시 시도
              </Btn>
            )}
          </Card>
        </Animated.View>
      </Screen>
      <AddItemSheet open={sheet === 'add'} onClose={() => setSheet(null)} />
      <WeekGoalSheet open={sheet === 'goal'} onClose={() => setSheet(null)} />
    </Canvas>
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
        // 다시 세우면 다음 기울임을 받는다
        if (Math.abs(y) > 0.8) pushed.current = false;
        if (!pushed.current && Math.abs(x) > 0.8 && Math.abs(y) < 0.35) {
          pushed.current = true;
          if (useSession.getState().itemId) router.push('/landscape');
          else toast('공부할 항목을 시작한 뒤 가로로 돌려 주세요');
        }
      });
      return () => sub.remove();
    }, []),
  );
  return null;
}
