import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/text';
import { router, useLocalSearchParams } from 'expo-router';
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
  Card,
  Group,
  Header,
  Label,
  Row,
  Screen,
  Segment,
  Sheet,
  cx,
} from '@/components/ui';
import { C, ICON } from '@/theme';
import { AddTodoSheet, TodoSheet } from '../calendar/todo';

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
                            : 'bg-cream/60',
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
    <View className="flex-1">
      <Screen>
        <Header
          title="학습 기록"
          right={
            <Pressable
              accessibilityLabel="캘린더 설정"
              onPress={() => setSheet('cal')}
              className="h-9 w-9 items-center justify-center rounded-full bg-cream"
            >
              <Settings2 size={ICON.md} color={C.ink} />
            </Pressable>
          }
        />
        {mode === '월간' ? (
          <>
            <Text className="text-caption text-sub">이번주 순공시간</Text>
            <Text className="text-title2 font-bold text-ink">{hm(weekly.data?.totalSec ?? 0)}</Text>
            <Text className="text-caption text-sub">
              {diffLabel(weekly.data?.diffFromLastWeekSec ?? 0)}
            </Text>
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
                    {goal.name} · 연속 {goal.streak}일째
                  </Text>
                </View>
                <ChevronRight size={ICON.md} color={C.sub} />
              </Card>
            ))}
            <View className="mt-5 flex-row items-center justify-between">
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
            <Segment
              items={['월간', '주간'] as const}
              value={mode}
              onChange={setMode}
              className="my-3 w-40 self-center"
            />
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
                        range === x ? 'bg-ink' : 'bg-cream',
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
                ['총 순공시간', `${Math.round((stats.data?.totalSec ?? 0) / 3600)}시간`],
                ['공부한 날', `${stats.data?.studyDays ?? 0}일`],
                ['최장 연속', `${stats.data?.longestStreak ?? 0}일`],
                ['주로 공부한 시간', `오후 ${(stats.data?.peakHour ?? 21) - 12}시`],
              ].map(([k, v]) => (
                <Card key={k} className="w-[48.5%] px-3 py-2.5">
                  <Text className="text-caption2 text-sub">{k}</Text>
                  <Text className="text-body font-bold text-ink">{v}</Text>
                </Card>
              ))}
            </View>
            <View className="mt-3 flex-row flex-wrap gap-[3px] rounded-2xl border border-line p-3">
              {(stats.data?.heatmap ?? []).map((h) => (
                <View
                  key={h.studyDate}
                  className="h-3 w-3 rounded-[2px]"
                  style={{ backgroundColor: ['#eef0ec', '#c8dccf', '#7aa592', C.brand][h.level] }}
                />
              ))}
            </View>
          </>
        ) : (
          <WeekView onMonth={() => setMode('월간')} />
        )}
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
    </View>
  );
}

function WeekView({ onMonth }: { onMonth: () => void }) {
  const tt = useQuery({ queryKey: ['timetable'], queryFn: api.timetable.get });
  const [offset, setOffset] = useState(0);
  const base = addDays(seoul(), offset * 7);
  const sun = addDays(base, -base.getDay());
  const days = Array.from({ length: 7 }, (_, i) => addDays(sun, i));
  const H = 22,
    START = 9;
  const toH = (t: string) => Number(t.slice(0, 2)) + Number(t.slice(3)) / 60;
  const blocks = [
    ...(tt.data?.classes ?? []).flatMap((c) =>
      c.days.map((d) => ({
        day: d,
        top: toH(c.startTime) - START,
        h: toH(c.endTime) - toH(c.startTime),
        label: c.subjectName,
        bg: c.color,
      })),
    ),
  ];
  return (
    <>
      <Segment
        items={['주간', '월간'] as const}
        value="주간"
        onChange={(v) => v === '월간' && onMonth()}
        className="w-40"
      />
      <View className="mt-4 flex-row items-center justify-between">
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
      <View className="mt-3 flex-row pl-7">
        {days.map((d) => (
          <View key={d.getDate()} className="flex-1 items-center">
            <Text className="text-caption2 text-sub">{WD[d.getDay()]}</Text>
            <View
              className={cx(
                'mt-1 h-7 w-7 items-center justify-center rounded-full',
                ymd(d) === today() && 'bg-ink',
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
      <View className="relative mt-2" style={{ height: 14 * H }}>
        {['09시', '12시', '15시', '18시', '21시'].map((t, i) => (
          <View
            key={t}
            className="absolute left-0 right-0 border-t border-line"
            style={{ top: i * 3 * H }}
          >
            <Text className="text-caption2 text-sub">{t}</Text>
          </View>
        ))}
        <View className="absolute inset-0 left-7 flex-row">
          {days.map((_, di) => (
            <View key={di} className="relative flex-1">
              {blocks
                .filter((b) => b.day === di)
                .map((b, i) => (
                  <View
                    key={i}
                    className="absolute left-0.5 right-0.5 rounded-md px-1 py-0.5"
                    style={{ top: b.top * H + 4, height: b.h * H, backgroundColor: b.bg }}
                  >
                    <Text className="text-caption2 leading-3 text-ink">{b.label}</Text>
                  </View>
                ))}
            </View>
          ))}
        </View>
      </View>
      <Text className="mt-2 text-caption2 text-sub">● 시간표 자동연동 ● 스터디룸 일정</Text>
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
