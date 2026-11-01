import { useState } from 'react';
import { Pressable, Share, View } from 'react-native';
import { Text } from '@/components/text';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { Check, ChevronRight, Pin, Users, X } from 'lucide-react-native';
import type { TimetableClass } from '@notelink/shared';
import { api } from '@/lib/api';
import { useHolidayPreference } from '@/lib/holiday-preference';
import { timeAgo, today, ymd, seoul } from '@/lib/dates';
import { toast } from '@/stores/toast';
import {
  Avatar,
  Badge,
  Btn,
  Card,
  Chip,
  Dashed,
  Header,
  Input,
  Label,
  Screen,
  Segment,
  Sheet,
  Toggle,
  cx,
} from '@/components/ui';
import { C, ICON } from '@/theme';
import { Month } from '../progress/record';
import { validYmd } from '../progress/goals';

// p.52 공휴일 · 캘린더 공유 · 공유받은 캘린더 / p.56 시간표

export function HolidayScreen() {
  const qc = useQueryClient();
  const year = seoul().getFullYear();
  const { auto, setAuto } = useHolidayPreference();
  const hol = useQuery({
    queryKey: ['holidays', year],
    queryFn: () => api.calendar.holidays(year),
  });
  const custom = useQuery({
    queryKey: ['holidays', 'custom'],
    queryFn: api.calendar.customHolidays,
  });
  const [adding, setAdding] = useState(false);
  const [v, setV] = useState('');
  const [date, setDate] = useState('');
  const hide = useMutation({
    mutationFn: ({ date, hidden }: { date: string; hidden: boolean }) =>
      api.calendar.setHolidayHidden(date, hidden),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['holidays', year] }),
  });
  const addCustom = useMutation({
    mutationFn: () => api.calendar.addCustomHoliday({ name: v.trim(), date }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['holidays', 'custom'] });
      setV('');
      setDate('');
      setAdding(false);
    },
  });
  const removeCustom = useMutation({
    mutationFn: api.calendar.removeCustomHoliday,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['holidays', 'custom'] }),
  });
  const upcoming = (hol.data ?? []).filter((h) => h._id >= today()).slice(0, 3);
  return (
    <Screen>
      <Header title="공휴일 설정" />
      <Card tone="white" className="flex-row items-center px-4 py-3">
        <View className="flex-1">
          <Text className="text-subhead font-semibold text-ink">공휴일 자동 연동</Text>
          <Text className="text-caption text-sub">
            대한민국 공휴일을 캘린더에 자동으로 표시해요
          </Text>
        </View>
        <Toggle label="공휴일 자동 연동" on={auto} onChange={setAuto} />
      </Card>
      <Label>다가오는 공휴일</Label>
      <View className={cx('gap-2', !auto && 'opacity-40')}>
        {upcoming.map((h) => (
          <Card key={h._id} tone="white" className="flex-row items-center px-4 py-3">
            <View className="flex-1">
              <Text className="text-caption2 text-sub">
                {Number(h._id.slice(5, 7))}월 {Number(h._id.slice(8))}일
              </Text>
              <Text className="text-callout font-semibold text-ink">{h.name}</Text>
            </View>
            <Pressable
              disabled={!auto}
              onPress={() => hide.mutate({ date: h._id, hidden: !h.hidden })}
            >
              <Badge tone={h.hidden ? 'gray' : 'mint'}>{h.hidden ? '숨김' : '표시중'}</Badge>
            </Pressable>
          </Card>
        ))}
      </View>
      <Label>사용자 정의 휴일</Label>
      {custom.data?.map((c) => (
        <Card key={c._id} tone="mint" className="mb-2 flex-row items-center px-4 py-3">
          <View className="flex-1 flex-row items-center gap-1.5">
            <Pin size={ICON.sm} color={C.sub} />
            <Text className="text-subhead text-ink">
              {c.name} ({Number(c.date.slice(5, 7))}/{Number(c.date.slice(8))})
            </Text>
          </View>
          <Pressable
            accessibilityLabel="삭제"
            onPress={() => removeCustom.mutate(c._id)}
            hitSlop={10}
          >
            <X size={ICON.sm} color={C.sub} />
          </Pressable>
        </Card>
      ))}
      {adding ? (
        <View className="gap-2">
          <Input value={v} onChangeText={setV} placeholder="예) 학교 개교기념일" autoFocus />
          <View className="flex-row gap-2">
            <Input
              className="flex-1"
              value={date}
              onChangeText={setDate}
              placeholder="쉬는 날 YYYY-MM-DD"
              keyboardType="numbers-and-punctuation"
              maxLength={10}
              invalid={!!date && !validYmd(date)}
              accessibilityLabel="휴일 날짜"
            />
            <Btn
              small
              className="w-20"
              disabled={!v.trim() || !validYmd(date)}
              loading={addCustom.isPending}
              onPress={() => addCustom.mutate()}
            >
              추가
            </Btn>
          </View>
        </View>
      ) : (
        <Dashed onPress={() => setAdding(true)}>+ 휴일 추가</Dashed>
      )}
    </Screen>
  );
}

export function CalShareScreen() {
  const qc = useQueryClient();
  const shares = useQuery({ queryKey: ['calendar-shares'], queryFn: api.calendar.shares });
  const [period, setPeriod] = useState<7 | 30 | null>(30);
  const start = ymd(new Date(seoul().getFullYear(), seoul().getMonth(), 1));
  const end = ymd(new Date(seoul().getFullYear(), seoul().getMonth() + 1, 0));
  const create = useMutation({
    mutationFn: () =>
      api.calendar.createShare({ rangeStart: start, rangeEnd: end, expiresInDays: period }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['calendar-shares'] }),
  });
  const revoke = useMutation({
    mutationFn: api.calendar.revokeShare,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['calendar-shares'] }),
  });
  const link = create.data?.url;
  return (
    <Screen>
      <Header title="캘린더 공유" />
      <Label>공유 범위 선택</Label>
      <Card tone="white" className="flex-row items-center px-4 py-3">
        <Text className="flex-1 text-subhead text-ink">
          {start.replaceAll('-', '.')} ~ {end.replaceAll('-', '.')}
        </Text>
        <ChevronRight size={ICON.sm} color={C.sub} />
      </Card>
      <Label>유효기간</Label>
      <View className="flex-row gap-2">
        {(
          [
            [7, '7일'],
            [30, '30일'],
            [null, '무제한'],
          ] as const
        ).map(([v, l]) => (
          <Chip key={l} on={period === v} onPress={() => setPeriod(v)}>
            {l}
          </Chip>
        ))}
      </View>
      <Btn className="mt-4" loading={create.isPending} onPress={() => create.mutate()}>
        공유 링크 생성
      </Btn>
      {link && (
        <>
          <View className="mt-3 flex-row items-center rounded-xl bg-cream px-4 py-3">
            <Text className="flex-1 text-footnote text-sub">{link}</Text>
            <Pressable
              onPress={async () => {
                await Clipboard.setStringAsync(`https://${link}`);
                toast('링크를 복사했어요');
              }}
            >
              <Text className="text-footnote font-semibold text-brand">복사</Text>
            </Pressable>
          </View>
          {/* 카카오톡 SDK 연동 전까지 OS 공유 시트로 카카오톡을 고를 수 있다 */}
          <Btn
            kind="sun"
            className="mt-2"
            onPress={() => Share.share({ message: `내 학습 캘린더를 공유해요 👉 https://${link}` })}
          >
            카카오톡으로 공유
          </Btn>
        </>
      )}
      <Label>공유한 링크 관리</Label>
      <View className="gap-2">
        {shares.data?.map((s) => (
          <Card key={s._id} tone="white" className="flex-row items-center px-4 py-3">
            <View className="flex-1">
              <Text className="text-subhead text-ink">
                {s.rangeStart.replaceAll('-', '.')} ~ {s.rangeEnd.slice(5).replace('-', '.')}
              </Text>
              <Text className="text-caption2 text-sub">{timeAgo(s.createdAt)} 생성</Text>
            </View>
            <Pressable onPress={() => revoke.mutate(s._id)} hitSlop={8}>
              <Text className="text-footnote text-danger">삭제</Text>
            </Pressable>
          </Card>
        ))}
      </View>
      <Card
        tone="mint"
        onPress={() => router.push('/cal-shared')}
        className="mt-3 flex-row items-center px-4 py-3.5"
      >
        <View className="flex-1 flex-row items-center gap-1.5">
          <Users size={ICON.sm} color={C.sub} />
          <Text className="text-subhead font-semibold text-ink">공유받은 캘린더 보기</Text>
        </View>
        <ChevronRight size={ICON.sm} color={C.sub} />
      </Card>
    </Screen>
  );
}

export function CalSharedScreen() {
  const recv = useQuery({
    queryKey: ['calendar-shares', 'received'],
    queryFn: api.calendar.received,
  });
  const sub = useMutation({
    mutationFn: api.calendar.subscribe,
    onSuccess: () => {
      router.back();
      toast('공유받은 일정을 내 캘린더에 추가했어요');
    },
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const s = recv.data?.find((s) => s._id === selected) ?? recv.data?.[0];
  const ym = month ?? s?.rangeStart.slice(0, 7) ?? today().slice(0, 7);
  const shift = (n: number) => {
    const d = new Date(`${ym}-01T00:00:00`);
    d.setMonth(d.getMonth() + n);
    setMonth(ymd(d).slice(0, 7));
  };
  return (
    <Screen
      footer={
        s && (
          <Btn loading={sub.isPending} onPress={() => sub.mutate(s._id)}>
            내 캘린더에 추가
          </Btn>
        )
      }
    >
      <Header title="공유받은 캘린더" />
      <View className="flex-row flex-wrap gap-2">
        {recv.data?.map((c) => (
          <Chip
            key={c._id}
            on={c._id === s?._id}
            onPress={() => {
              setSelected(c._id);
              setMonth(c.rangeStart.slice(0, 7));
            }}
          >
            {c.ownerNickname}
          </Chip>
        ))}
      </View>
      <View className="flex-row justify-between">
        <Btn small onPress={() => shift(-1)}>
          이전 달
        </Btn>
        <Btn small onPress={() => shift(1)}>
          다음 달
        </Btn>
      </View>
      {s && (
        <>
          <Card tone="white" className="flex-row items-center gap-3 px-4 py-3">
            <Avatar name={s.ownerNickname} size={34} tone="mint" />
            <View className="flex-1">
              <Text className="text-subhead font-semibold text-ink">
                {s.ownerNickname}님이 공유한 캘린더
              </Text>
              <Text className="text-caption2 text-sub">
                {s.rangeStart.replaceAll('-', '.')} ~ {s.rangeEnd.slice(5).replace('-', '.')} 공유됨
              </Text>
            </View>
            <Badge tone="gray">읽기 전용</Badge>
          </Card>
          <Text className="mt-5 mb-3 text-center text-callout font-bold text-ink">
            {ym.slice(0, 4)}년 {Number(ym.slice(5))}월
          </Text>
          <Month ym={ym} shared={new Set(s.days)} />
          <Text className="mt-3 text-caption2 text-sub">● 공유자의 일정 ● 내 일정</Text>
        </>
      )}
    </Screen>
  );
}

/* ── p.56 시간표 ─────────────────────────────────── */

const COLORS = ['#dfece4', '#e3e8f4', '#f6dfdf', '#faf0cf', '#efe9da'] as const;
const WEEK = ['월', '화', '수', '목', '금'];

export function TimetableScreen() {
  const qc = useQueryClient();
  const tt = useQuery({ queryKey: ['timetable'], queryFn: api.timetable.get });
  const [sheet, setSheet] = useState<null | 'add' | 'share'>(null);
  const [pick, setPick] = useState<TimetableClass | null>(null);
  const remove = useMutation({
    mutationFn: api.timetable.removeClass,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['timetable'] });
      setPick(null);
      toast('수업을 삭제했어요');
    },
  });
  const classes = tt.data?.classes ?? [];
  const H = 26;
  const toH = (t: string) => Number(t.slice(0, 2)) + Number(t.slice(3)) / 60;
  return (
    <View className="flex-1">
      <Screen>
        <Header
          title="내 시간표"
          sub={`2026-2학기 · 총 ${classes.reduce((a, c) => a + c.days.length, 0)}개 수업`}
          right={
            <Pressable
              onPress={() => setSheet('share')}
              className="rounded-full bg-mint px-3 py-1.5"
            >
              <View className="flex-row items-center gap-1.5">
                <Users size={ICON.xs} color={C.brand} />
                <Text className="text-caption font-semibold text-brand">공유</Text>
              </View>
            </Pressable>
          }
        />
        <View className="flex-row pl-6">
          {WEEK.map((d) => (
            <Text key={d} className="flex-1 text-center text-caption text-sub">
              {d}
            </Text>
          ))}
        </View>
        <View className="relative mt-1" style={{ height: 10 * H }}>
          {Array.from({ length: 10 }, (_, i) => (
            <View
              key={i}
              className="absolute left-0 right-0 border-t border-line"
              style={{ top: i * H }}
            >
              <Text className="text-caption2 text-sub">{String(9 + i).padStart(2, '0')}</Text>
            </View>
          ))}
          <View className="absolute inset-0 left-6 flex-row">
            {[1, 2, 3, 4, 5].map((d) => (
              <View key={d} className="relative flex-1">
                {classes
                  .filter((c) => c.days.includes(d))
                  .map((c) => (
                    <Pressable
                      key={c._id}
                      onPress={() => setPick(c)}
                      className="absolute left-0.5 right-0.5 rounded-md px-1 py-0.5"
                      style={{
                        top: (toH(c.startTime) - 9) * H + 2,
                        height: (toH(c.endTime) - toH(c.startTime)) * H - 3,
                        backgroundColor: c.color,
                      }}
                    >
                      <Text className="text-caption2 font-bold text-ink">{c.subjectName}</Text>
                      {!!c.location && (
                        <Text className="text-caption2 text-ink/70">{c.location}</Text>
                      )}
                    </Pressable>
                  ))}
              </View>
            ))}
          </View>
        </View>
        <Dashed onPress={() => setSheet('add')}>+ 수업 추가</Dashed>
        <View className="mt-3 rounded-xl bg-cream px-3 py-2.5">
          <Text className="text-caption text-sub">
            시간표를 넣으면 학습 기록 주간 보기에 자동으로 표시돼요
          </Text>
        </View>
      </Screen>
      <AddClassSheet open={sheet === 'add'} onClose={() => setSheet(null)} />
      <ShareTimetableSheet open={sheet === 'share'} onClose={() => setSheet(null)} />
      <Sheet open={!!pick} onClose={() => setPick(null)} title={pick?.subjectName}>
        <Text className="text-footnote text-sub">
          {pick?.days.map((d) => WEEK[d - 1]).join(' · ')} · {pick?.startTime} – {pick?.endTime}
          {pick?.location ? ` · ${pick.location}` : ''}
        </Text>
        <Btn
          kind="danger"
          className="mt-4"
          loading={remove.isPending}
          onPress={() => pick && remove.mutate(pick._id)}
        >
          수업 삭제
        </Btn>
      </Sheet>
    </View>
  );
}

function AddClassSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('수학 II');
  const [days, setDays] = useState([2, 4]);
  const [start, setStart] = useState('10:00');
  const [end, setEnd] = useState('11:30');
  const [place, setPlace] = useState('3-2 교실');
  const [color, setColor] = useState<string>(COLORS[1]);
  const add = useMutation({
    mutationFn: () =>
      api.timetable.addClass({
        subjectName: name,
        days,
        startTime: start,
        endTime: end,
        location: place,
        color,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['timetable'] });
      onClose();
      toast(`${name} 수업을 추가했어요`);
    },
  });
  const valid =
    /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(start) &&
    /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(end) &&
    start < end &&
    days.length > 0 &&
    name.trim();
  return (
    <Sheet open={open} onClose={onClose}>
      <Text className="text-headline font-bold text-ink">수업 추가</Text>
      <Label>과목명</Label>
      <Input value={name} onChangeText={setName} />
      <Label>요일</Label>
      <View className="flex-row gap-2">
        {WEEK.map((d, i) => {
          const on = days.includes(i + 1);
          return (
            <Pressable
              key={d}
              onPress={() => setDays((p) => (on ? p.filter((x) => x !== i + 1) : [...p, i + 1]))}
              className={cx(
                'h-10 w-10 items-center justify-center rounded-full',
                on ? 'bg-brand' : 'bg-cream',
              )}
            >
              <Text className={cx('text-footnote font-semibold', on ? 'text-white' : 'text-sub')}>
                {d}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Label>시간</Label>
      <View className="flex-row items-center gap-2">
        <Input
          className="flex-1"
          value={start}
          onChangeText={setStart}
          keyboardType="numbers-and-punctuation"
          maxLength={5}
        />
        <Text className="text-sub">–</Text>
        <Input
          className="flex-1"
          value={end}
          onChangeText={setEnd}
          keyboardType="numbers-and-punctuation"
          maxLength={5}
        />
      </View>
      <Label>장소 (선택)</Label>
      <Input value={place} onChangeText={setPlace} />
      <Label>색상</Label>
      <View className="flex-row gap-3">
        {COLORS.map((c) => (
          <Pressable
            key={c}
            accessibilityLabel="색상"
            onPress={() => setColor(c)}
            className={cx(
              'h-9 w-9 items-center justify-center rounded-full border border-line',
              color === c && 'border-2 border-brand',
            )}
            style={{ backgroundColor: c }}
          >
            {color === c && <Check size={ICON.xs} color={C.brand} />}
          </Pressable>
        ))}
      </View>
      <Btn className="mt-6" disabled={!valid} loading={add.isPending} onPress={() => add.mutate()}>
        추가하기
      </Btn>
    </Sheet>
  );
}

function ShareTimetableSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const friends = useQuery({ queryKey: ['friends'], queryFn: api.social.friends, enabled: open });
  const sharing = useQuery({
    queryKey: ['timetable-shares'],
    queryFn: api.timetable.shares,
    enabled: open,
  });
  const [mode, setMode] = useState<'전체 공개' | '비는 시간만'>('전체 공개');
  // 아무도 고르지 않은 상태로 시작하고, 지금 친구 목록에 있는 사람만 보낸다
  const [pick, setPick] = useState<string[]>([]);
  const chosen = pick.filter((id) => friends.data?.some((f) => f.userId === id));
  const share = useMutation({
    mutationFn: () =>
      api.timetable.share({ friendIds: chosen, mode: mode === '전체 공개' ? 'full' : 'free_only' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['timetable-shares'] });
      onClose();
      toast(`${chosen.length}명에게 시간표를 공유했어요`);
    },
  });
  return (
    <Sheet open={open} onClose={onClose}>
      <Text className="text-headline font-bold text-ink">시간표 공유</Text>
      <Text className="text-caption text-sub">
        공유하면 친구의 학습 기록 주간 보기에 내 수업이 함께 표시돼요.
      </Text>
      <Label>공유 방식</Label>
      <Segment
        items={['전체 공개', '비는 시간만'] as const}
        value={mode}
        onChange={setMode}
        className="w-60"
      />
      <Label>공유할 친구</Label>
      <View className="gap-2">
        {friends.data?.map((f) => {
          const on = pick.includes(f.userId);
          return (
            <Pressable
              key={f._id}
              onPress={() =>
                setPick((p) => (on ? p.filter((x) => x !== f.userId) : [...p, f.userId]))
              }
              className={cx(
                'flex-row items-center gap-3 rounded-2xl border px-4 py-3',
                on ? 'border-brand/40 bg-mint' : 'border-transparent bg-cream',
              )}
            >
              <Avatar name={f.nickname} size={30} tone="mint" />
              <View className="flex-1">
                <Text className="text-subhead font-semibold text-ink">{f.nickname}</Text>
                {sharing.data?.some((x) => x.friendId === f.userId) && (
                  <Text className="text-caption2 text-sub">공유 중</Text>
                )}
              </View>
              <View
                className={cx(
                  'h-6 w-6 items-center justify-center rounded-full border',
                  on ? 'border-brand bg-brand' : 'border-cream-2',
                )}
              >
                {on && <Check size={ICON.xs} color="#fff" />}
              </View>
            </Pressable>
          );
        })}
      </View>
      <Btn
        className="mt-5"
        disabled={!chosen.length}
        loading={share.isPending}
        onPress={() => share.mutate()}
      >{`${chosen.length}명에게 공유하기`}</Btn>
    </Sheet>
  );
}
