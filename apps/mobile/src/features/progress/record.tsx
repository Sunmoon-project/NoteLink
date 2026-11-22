import { useCallback, useRef, useState } from 'react';
import { View } from 'react-native';
import { Pressable } from '@/components/press';
import { Text } from '@/components/text';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Flag,
  Link2,
  Repeat,
  Settings2,
  Target,
  Users,
} from 'lucide-react-native';
import { api } from '@/lib/api';
import { useHolidayPreference } from '@/lib/holiday-preference';
import { addDays, diffLabel, dLabel, hm, md, parse, today, ymd, WD, seoul } from '@/lib/dates';
import {
  Badge,
  Btn,
  Canvas,
  Card,
  Group,
  Header,
  Label,
  Row,
  Screen,
  Segment,
  Sheet,
  Swap,
  cx,
} from '@/components/ui';
import { C, ICON } from '@/theme';
import { AddTodoSheet, TodoSheet } from '../calendar/todo';
import { LoadError } from './load-error';

// p.50 학습 기록 · 주간 보기 · 날짜별 할 일

export function Month({
  ym,
  selected,
  onPick,
  levels,
  dots,
  shared,
  holidays,
}: {
  ym: string;
  selected?: string;
  onPick?: (d: string) => void;
  levels?: Record<string, number>;
  dots?: Set<string>;
  shared?: Set<string>;
  holidays?: Record<string, string>;
}) {
  const first = parse(`${ym}-01`);
  const n = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const cells: (string | null)[] = [
    ...Array(first.getDay()).fill(null),
    ...Array.from({ length: n }, (_, i) =>
      ymd(new Date(first.getFullYear(), first.getMonth(), i + 1)),
    ),
  ];
  return (
    <View>
      <View className="flex-row">
        {WD.map((d, i) => (
          <Text
            key={d}
            className={cx('flex-1 text-center text-caption2', i === 0 ? 'text-danger' : 'text-sub')}
          >
            {d}
          </Text>
        ))}
      </View>
      <View className="mt-2 flex-row flex-wrap">
        {cells.map((d, i) => {
          if (!d) return <View key={`e${i}`} className="h-10 w-[14.28%]" />;
          const lv = levels?.[d] ?? 0;
          const sel = d === selected;
          return (
            <Pressable
              key={d}
              accessibilityLabel={`${d}${holidays?.[d] ? ` ${holidays[d]}` : ''}`}
              onPress={() => onPick?.(d)}
              className="h-10 w-[14.28%] items-center justify-center"
            >
              <View
                className={cx(
                  'h-8 w-8 items-center justify-center rounded-lg',
                  sel
                    ? 'border-2 border-sun bg-ink'
                    : lv >= 3
                      ? 'bg-brand'
                      : lv === 2
                        ? 'bg-brand/70'
                        : lv === 1
                          ? 'bg-brand/25'
                          : shared?.has(d)
                            ? 'bg-mint'
                            : 'bg-white',
                )}
              >
                <Text
                  className={cx(
                    'text-caption',
                    sel || lv >= 2
                      ? 'font-semibold text-white'
                      : shared?.has(d)
                        ? 'font-semibold text-brand'
                        : holidays?.[d]
                          ? 'text-danger'
                          : 'text-ink/80',
                  )}
                >
                  {Number(d.slice(8))}
                </Text>
              </View>
              {dots?.has(d) && <View className="absolute bottom-0 h-1 w-1 rounded-full bg-sun" />}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function RecordScreen() {
  const params = useLocalSearchParams<{ mode?: '월간' | '주간' }>();
  const [mode, setMode] = useState<'월간' | '주간'>(params.mode ?? '월간');
  const [cursor, setCursor] = useState(today().slice(0, 7));
  const [day, setDay] = useState(today());
  const [sheet, setSheet] = useState<null | 'todo' | 'addTodo' | 'cal'>(null);
  const [range, setRange] = useState<'all' | '90d' | '30d'>('all');
  const weekly = useQuery({ queryKey: ['study', 'weekly'], queryFn: api.study.weekly });
  const month = useQuery({
    queryKey: ['study', 'month', cursor],
    queryFn: () => api.study.month(cursor),
  });
  const stats = useQuery({
    queryKey: ['study', 'stats', range],
    queryFn: () => api.study.stats(range),
  });
  const ddays = useQuery({ queryKey: ['ddays'], queryFn: api.calendar.ddays });
  const goals = useQuery({ queryKey: ['goals', 'recurring'], queryFn: api.study.recurringGoals });
  const levels = Object.fromEntries((month.data ?? []).map((d) => [d.studyDate, d.level]));
  const dots = new Set((month.data ?? []).filter((d) => d.hasTodo).map((d) => d.studyDate));
  const next = ddays.data?.find((d) => d.daysLeft >= 0);
  const shift = (n: number) => {
    const d = parse(`${cursor}-01`);
    setCursor(ymd(new Date(d.getFullYear(), d.getMonth() + n, 1)).slice(0, 7));
  };
  const [y, m] = cursor.split('-').map(Number);
  const { auto } = useHolidayPreference();
  const holidays = useQuery({
    queryKey: ['holidays', y],
    queryFn: () => api.calendar.holidays(y!),
  });
  const custom = useQuery({
    queryKey: ['holidays', 'custom'],
    queryFn: api.calendar.customHolidays,
  });
  const holidayNames: Record<string, string> = Object.fromEntries([
    ...(auto ? (holidays.data ?? []).filter((h) => !h.hidden).map((h) => [h._id, h.name]) : []),
    ...(custom.data ?? []).map((h) => [h.date, h.name]),
  ]);
  return (
    <Canvas>
      <Screen>
        <Header
          title="학습 기록"
          right={
            <Pressable
              accessibilityLabel="캘린더 설정"
              onPress={() => setSheet('cal')}
              className="h-11 w-11 items-center justify-center rounded-full bg-white"
            >
              <Settings2 size={ICON.md} color={C.ink} />
            </Pressable>
          }
        />
        {/* 월간 · 주간 버튼은 두 보기 위 같은 자리 · 같은 순서에 둔다(보기마다 따로 두면 누를 때마다 순서가 바뀌었다) */}
        <Segment
          items={['월간', '주간'] as const}
          value={mode}
          onChange={setMode}
          className="mb-4 w-40 self-center"
        />
        <Swap k={mode}>
          {mode === '월간' ? (
            <>
              <Text className="text-subhead font-semibold text-ink">이번주 순공시간</Text>
              <Text className="text-title2 font-bold text-ink">
                {weekly.data ? hm(weekly.data.totalSec) : '-'}
              </Text>
              {weekly.data && (
                <Text className="text-caption text-sub">
                  {diffLabel(weekly.data.diffFromLastWeekSec)}
                </Text>
              )}
              {weekly.isError && !weekly.data && (
                <View className="mt-2 gap-2">
                  <Text className="text-caption text-sub">이번주 기록을 불러오지 못했어요</Text>
                  <Btn small onPress={() => void weekly.refetch()}>
                    이번주 기록 다시 시도
                  </Btn>
                </View>
              )}
              <Label
                right={
                  <Pressable onPress={() => router.push('/dday')}>
                    <Text className="text-footnote text-brand">전체 ›</Text>
                  </Pressable>
                }
              >
                다가오는 D-day
              </Label>
              {next && (
                <Card
                  tone="white"
                  onPress={() => router.push('/dday')}
                  className="flex-row items-center gap-3 px-4 py-3"
                >
                  <Target size={ICON.md} color={C.brand} />
                  <View className="flex-1">
                    <Text className="text-subhead font-semibold text-ink">{next.title}</Text>
                    <Text className="text-caption text-sub">
                      {next.kind} · {md(next.date)}
                    </Text>
                  </View>
                  <Badge tone="sun">{dLabel(next.daysLeft)}</Badge>
                </Card>
              )}
              <Card onPress={() => router.push('/repeat')} className="mt-2 p-3">
                <Text>+ 반복 목표 추가</Text>
              </Card>
              {goals.data?.map((goal) => (
                <Card
                  key={goal._id}
                  tone="white"
                  onPress={() => router.push({ pathname: '/repeat', params: { id: goal._id } })}
                  className="mt-2 flex-row items-center gap-3 px-4 py-3"
                >
                  <Repeat size={ICON.md} color={C.brand} />
                  <View className="flex-1">
                    <Text className="text-subhead font-semibold text-ink">반복 목표</Text>
                    <Text className="text-caption text-sub">
                      {goal.name} · 연속 {goal.streak}주 달성 중
                    </Text>
                  </View>
                  <ChevronRight size={ICON.md} color={C.sub} />
                </Card>
              ))}
              <View className="mt-5 mb-3 flex-row items-center justify-between">
                <Pressable accessibilityLabel="이전 달" onPress={() => shift(-1)} hitSlop={10}>
                  <ChevronLeft size={ICON.md} color={C.sub} />
                </Pressable>
                <Text className="text-callout font-bold text-ink">
                  {y}년 {m}월
                </Text>
                <Pressable accessibilityLabel="다음 달" onPress={() => shift(1)} hitSlop={10}>
                  <ChevronRight size={ICON.md} color={C.sub} />
                </Pressable>
              </View>
              <Month
                ym={cursor}
                holidays={holidayNames}
                levels={levels}
                dots={dots}
                selected={day}
                onPick={(d) => {
                  setDay(d);
                  setSheet('todo');
                }}
              />
              {Object.entries(holidayNames)
                .filter(([date]) => date.startsWith(cursor))
                .map(([date, name]) => (
                  <Text key={date} className="text-caption text-danger">
                    {date} · {name}
                  </Text>
                ))}
              {month.isError && !month.data && (
                <LoadError message="이번 달 기록을 불러오지 못했어요" retry={month.refetch} />
              )}
              <Text className="mt-2 text-caption2 text-sub">
                색이 진할수록 공부 시간이 길고, 점은 할 일이 있는 날이에요
              </Text>
              <Label
                right={
                  <View className="flex-row gap-1">
                    {(['all', '90d', '30d'] as const).map((x) => (
                      <Pressable
                        key={x}
                        onPress={() => setRange(x)}
                        className={cx(
                          'rounded-full px-2 py-0.5',
                          range === x ? 'bg-brand' : 'bg-white',
                        )}
                      >
                        <Text
                          className={cx('text-caption2', range === x ? 'text-white' : 'text-ink')}
                        >
                          {{ all: '전체', '90d': '90일', '30d': '30일' }[x]}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                }
              >
                <Text className="text-footnote font-bold text-ink">누적 기록</Text>
              </Label>
              <View className="flex-row flex-wrap justify-between gap-y-2">
                {[
                  [
                    '총 순공시간',
                    stats.data ? `${Math.round(stats.data.totalSec / 3600)}시간` : '-',
                  ],
                  ['공부한 날', stats.data ? `${stats.data.studyDays}일` : '-'],
                  ['최장 연속', stats.data ? `${stats.data.longestStreak}일` : '-'],
                  [
                    '주로 공부한 시간',
                    stats.data?.peakHour == null || stats.data.peakHour < 0
                      ? '-'
                      : `${stats.data.peakHour < 12 ? '오전' : '오후'} ${stats.data.peakHour % 12 || 12}시`,
                  ],
                ].map(([k, v]) => (
                  <Card key={k} className="w-[48.5%] px-3 py-2.5">
                    <Text className="text-caption2 text-sub">{k}</Text>
                    <Text className="text-body font-bold text-ink">{v}</Text>
                  </Card>
                ))}
              </View>
              {stats.isError && !stats.data && (
                <View className="mt-2 gap-2">
                  <Text className="text-caption text-sub">누적 기록을 불러오지 못했어요</Text>
                  <Btn small onPress={() => void stats.refetch()}>
                    누적 기록 다시 시도
                  </Btn>
                </View>
              )}
              <View className="mt-3 flex-row flex-wrap gap-[3px] rounded-card bg-white p-4">
                {(stats.data?.heatmap ?? []).map((h) => (
                  <View
                    key={h.studyDate}
                    testID={`heatmap-${h.studyDate}`}
                    className="h-3 w-3 rounded-[2px]"
                    // 서버 level 은 0~4 라서 3 이상은 월간 캘린더처럼 가장 진한 색을 쓴다
                    style={{
                      backgroundColor: ['#eef0ec', '#c8dccf', '#7aa592', C.brand][
                        Math.min(h.level, 3)
                      ],
                    }}
                  />
                ))}
              </View>
            </>
          ) : (
            <WeekView />
          )}
        </Swap>
      </Screen>
      <TodoSheet
        open={sheet === 'todo'}
        date={day}
        onClose={() => setSheet(null)}
        onAdd={() => setSheet('addTodo')}
      />
      <AddTodoSheet open={sheet === 'addTodo'} date={day} onClose={() => setSheet('todo')} />
      <Sheet open={sheet === 'cal'} onClose={() => setSheet(null)} title="캘린더 설정">
        <Group>
          <Row
            icon={Flag}
            chevron
            onPress={() => {
              setSheet(null);
              router.push('/holiday');
            }}
          >
            공휴일 설정
          </Row>
          <Row
            icon={Link2}
            chevron
            onPress={() => {
              setSheet(null);
              router.push('/cal-share');
            }}
          >
            캘린더 공유 설정
          </Row>
          <Row
            icon={Users}
            chevron
            onPress={() => {
              setSheet(null);
              router.push('/cal-shared');
            }}
          >
            공유받은 캘린더
          </Row>
          <Row
            icon={CalendarDays}
            chevron
            onPress={() => {
              setSheet(null);
              router.push('/timetable');
            }}
          >
            내 시간표
          </Row>
        </Group>
      </Sheet>
    </Canvas>
  );
}

/** 같은 요일에 시간이 겹치는 블록을 나란히 놓는다. 아니면 나중 블록이 앞 블록을 가린다. */
// ponytail: 칸 수는 요일 전체의 최댓값. 겹치는 묶음별로 넓히는 건 빽빽해지면
export function laneBlocks<T extends { top: number; h: number }>(items: T[]) {
  const ends: number[] = [];
  const placed = [...items]
    .sort((a, b) => a.top - b.top)
    .map((block) => {
      const free = ends.findIndex((end) => end <= block.top);
      const lane = free < 0 ? ends.length : free;
      ends[lane] = block.top + block.h;
      return { block, lane };
    });
  return placed.map((p) => ({ ...p, lanes: ends.length }));
}

/** 친구 시간표 색(배경 · 왼쪽 띠). 공유받은 순서대로 돌려 쓴다 */
const FRIEND_COLORS = [
  { bg: '#f8dede', bar: '#d77a7a' },
  { bg: '#dde8f8', bar: '#6d93cf' },
  { bg: '#f7edd2', bar: '#c9a23f' },
  { bg: '#e8def6', bar: '#9a7ad0' },
  { bg: '#d6f1ec', bar: '#45a594' },
  { bg: '#f6dfee', bar: '#c56ea6' },
];

function WeekView() {
  const tt = useQuery({ queryKey: ['timetable'], queryFn: api.timetable.get });
  const rooms = useQuery({ queryKey: ['my-rooms'], queryFn: api.rooms.mine });
  // SOC-009: 나에게 공유된 친구 시간표를 겹쳐 그린다. 끈 친구만 기억한다(새로 공유받은 친구는 켜진 채로 보인다)
  // 친구를 끊거나 공유가 바뀌면 바로 사라져야 하므로 늘 오래된 것으로 보고(열 때마다 다시 읽음), 다른 화면에 다녀와도 다시 읽는다
  const friends = useQuery({
    queryKey: ['timetable', 'shared'],
    queryFn: api.timetable.shared,
    staleTime: 0,
  });
  const refetchFriends = friends.refetch;
  const focusedOnce = useRef(false);
  useFocusEffect(
    useCallback(() => {
      // 처음 열 때는 위 쿼리가 읽는다
      if (focusedOnce.current) void refetchFriends();
      focusedOnce.current = true;
    }, [refetchFriends]),
  );
  const [hiddenFriends, setHiddenFriends] = useState<ReadonlySet<string>>(new Set());
  const toggleFriend = (ownerId: string) =>
    setHiddenFriends((prev) => {
      const next = new Set(prev);
      if (next.has(ownerId)) next.delete(ownerId);
      else next.add(ownerId);
      return next;
    });
  const friendList = (friends.data ?? []).map((f, i) => ({
    ...f,
    color: FRIEND_COLORS[i % FRIEND_COLORS.length]!,
  }));
  const friendClasses = friendList
    .filter((f) => !hiddenFriends.has(f.ownerId))
    .flatMap((f) => f.classes.map((c) => ({ ...c, friend: f })));
  const [offset, setOffset] = useState(0);
  const base = addDays(seoul(), offset * 7);
  const sun = addDays(base, -base.getDay());
  const days = Array.from({ length: 7 }, (_, i) => addDays(sun, i));
  const H = 22;
  const toH = (t: string) => Number(t.slice(0, 2)) + Number(t.slice(3)) / 60;
  // 교시 규칙은 서울 기준 매일 반복한다. 뽀모도로는 고정 시각 일정이 아니다.
  const roomPeriods = (rooms.data ?? []).flatMap((room) =>
    room.timerRule?.enabled && room.timerRule.type === 'period'
      ? room.timerRule.periods
          .filter(
            (p) =>
              /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(p.start) &&
              /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/.test(p.end) &&
              toH(p.start) >= 0 &&
              toH(p.end) <= 24 &&
              toH(p.end) > toH(p.start),
          )
          .map((p) => ({ ...p, roomTitle: room.title }))
      : [],
  );
  const starts = [
    ...(tt.data?.classes ?? []).map((c) => toH(c.startTime)),
    ...roomPeriods.map((p) => toH(p.start)),
    ...friendClasses.map((c) => toH(c.startTime)),
  ];
  const ends = [
    ...(tt.data?.classes ?? []).map((c) => toH(c.endTime)),
    ...roomPeriods.map((p) => toH(p.end)),
    ...friendClasses.map((c) => toH(c.endTime)),
  ];
  const START = Math.min(9, ...starts.map(Math.floor));
  const END = Math.max(23, ...ends.map(Math.ceil));
  const blocks: {
    day: number;
    top: number;
    h: number;
    label: string;
    bg: string;
    bar?: string;
  }[] = [
    ...(tt.data?.classes ?? []).flatMap((c) =>
      c.days.map((d) => ({
        day: d,
        top: toH(c.startTime) - START,
        h: toH(c.endTime) - toH(c.startTime),
        label: c.subjectName,
        bg: c.color,
      })),
    ),
    // 친구 수업: 친구별 색 + 왼쪽 띠. 빈 시간만 공유면 과목명이 없어 「바쁨」
    ...friendClasses.flatMap((c) =>
      c.days.map((d) => ({
        day: d,
        top: toH(c.startTime) - START,
        h: toH(c.endTime) - toH(c.startTime),
        label: `${c.friend.nickname} · ${c.subjectName ?? '바쁨'}`,
        bg: c.friend.color.bg,
        bar: c.friend.color.bar,
      })),
    ),
    ...roomPeriods.flatMap((p) =>
      days.map((d) => ({
        day: d.getDay(),
        top: toH(p.start) - START,
        h: toH(p.end) - toH(p.start),
        label: `스터디룸 · ${p.roomTitle} · ${p.label}`,
        bg: '#dfece4',
      })),
    ),
  ];
  return (
    <>
      <View className="flex-row items-center justify-between">
        <Pressable onPress={() => setOffset((o) => o - 1)} hitSlop={10}>
          <ChevronLeft size={ICON.md} color={C.sub} />
        </Pressable>
        <Text className="text-callout font-bold text-ink">
          {sun.getMonth() + 1}월 {sun.getDate()}일 – {addDays(sun, 6).getDate()}일
        </Text>
        <Pressable onPress={() => setOffset((o) => o + 1)} hitSlop={10}>
          <ChevronRight size={ICON.md} color={C.sub} />
        </Pressable>
      </View>
      {friendList.length > 0 && (
        <View className="mt-3 flex-row flex-wrap gap-1.5">
          {friendList.map((f) => {
            const on = !hiddenFriends.has(f.ownerId);
            return (
              <Pressable
                key={f.ownerId}
                testID={`friend-chip-${f.ownerId}`}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${f.nickname} 시간표 ${on ? '숨기기' : '보이기'}`}
                onPress={() => toggleFriend(f.ownerId)}
                className={cx(
                  'flex-row items-center gap-1 rounded-full border px-2.5 py-1',
                  on ? 'border-transparent' : 'border-fill opacity-50',
                )}
                style={on ? { backgroundColor: f.color.bg } : undefined}
              >
                <View className="h-2 w-2 rounded-full" style={{ backgroundColor: f.color.bar }} />
                <Text className="text-caption2 text-ink">
                  {f.nickname}
                  {f.mode === 'free_only' ? ' · 빈 시간' : ''}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
      <View className="mt-3 flex-row pl-7">
        {days.map((d) => (
          <View key={d.getDate()} className="flex-1 items-center">
            <Text className="text-caption2 text-sub">{WD[d.getDay()]}</Text>
            <View
              className={cx(
                'mt-1 h-7 w-7 items-center justify-center rounded-full',
                ymd(d) === today() && 'bg-brand',
              )}
            >
              <Text
                className={cx(
                  'text-footnote',
                  ymd(d) === today() ? 'font-bold text-white' : 'text-ink',
                )}
              >
                {d.getDate()}
              </Text>
            </View>
          </View>
        ))}
      </View>
      <View className="relative mt-2" style={{ height: (END - START) * H }}>
        {Array.from(
          { length: END - START },
          (_, i) => `${String(START + i).padStart(2, '0')}시`,
        ).map((t, i) => (
          <View
            key={t}
            className="absolute left-0 right-0 border-t border-fill"
            style={{ top: i * H }}
          >
            <Text className="text-caption2 text-sub">{t}</Text>
          </View>
        ))}
        <View className="absolute inset-0 left-7 flex-row">
          {days.map((_, di) => (
            <View key={di} className="relative flex-1">
              {laneBlocks(
                blocks
                  .filter((b) => b.day === di)
                  // 겹침은 그려지는 위치로 판단한다
                  .map((b) => {
                    const h = Math.max(1, b.h * H - 4);
                    const maxTop = (END - START) * H - h;
                    return { ...b, h, top: Math.max(0, Math.min(b.top * H + 4, maxTop)) };
                  }),
              ).map(({ block: b, lane, lanes }, i) => (
                <View
                  key={i}
                  className="absolute rounded-md px-1 py-0.5"
                  style={{
                    left: `${(lane * 100) / lanes}%`,
                    width: `${100 / lanes}%`,
                    top: b.top,
                    height: b.h,
                    backgroundColor: b.bg,
                    ...(b.bar ? { borderLeftWidth: 3, borderLeftColor: b.bar } : null),
                  }}
                >
                  <Text className="text-caption2 leading-3 text-ink">{b.label}</Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      </View>
      {tt.isError && !tt.data && (
        <LoadError message="시간표를 불러오지 못했어요" retry={tt.refetch} />
      )}
      <Text className="mt-2 text-caption2 text-sub">
        ● 시간표 자동연동 ● 스터디룸 교시 일정 ● 친구 시간표
      </Text>
      {friends.data && friends.data.length === 0 && (
        <Text className="mt-1 text-caption2 text-sub">공유받은 친구 시간표가 없어요</Text>
      )}
      {friends.isError && !friends.data && (
        <View className="mt-2">
          <Text>친구 시간표를 불러오지 못했어요</Text>
          <Btn small onPress={() => void friends.refetch()}>
            친구 시간표 다시 시도
          </Btn>
        </View>
      )}
      {rooms.isError && (
        <View className="mt-2">
          <Text>스터디룸 일정을 불러오지 못했어요</Text>
          <Btn small onPress={() => void rooms.refetch()}>
            일정 다시 시도
          </Btn>
        </View>
      )}
      <Card
        tone="mint"
        onPress={() => router.push('/timetable')}
        className="mt-3 flex-row items-center px-4 py-3.5"
      >
        <View className="flex-1 flex-row items-center gap-1.5">
          <CalendarDays size={ICON.sm} color={C.sub} />
          <Text className="text-subhead font-semibold text-ink">내 시간표 편집하기</Text>
        </View>
        <ChevronRight size={ICON.md} color={C.sub} />
      </Card>
    </>
  );
}
