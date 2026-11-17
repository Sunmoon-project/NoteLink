import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/text';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DDay } from '@notelink/shared';
import { api } from '@/lib/api';
import { addDays, dLabel, md, parse, ymd, seoul } from '@/lib/dates';
import { toast } from '@/stores/toast';
import {
  Alert,
  Badge,
  Btn,
  Canvas,
  Card,
  Dashed,
  Header,
  Input,
  Label,
  Screen,
  Toggle,
  cx,
} from '@/components/ui';
import {
  BookOpen,
  Flame,
  GraduationCap,
  NotebookPen,
  PartyPopper,
  Target,
} from 'lucide-react-native';
import { ICON, C } from '@/theme';
import { LoadError } from './load-error';

// p.51 #13 D-day 관리 / #14 반복 목표 설정

/** 'YYYY-MM-DD'이면서 실제 있는 날짜인지 (2026-02-30 같은 값은 거른다) */
export const validYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && ymd(parse(s)) === s;

export function DDayScreen() {
  const qc = useQueryClient();
  const ddays = useQuery({ queryKey: ['ddays'], queryFn: api.calendar.ddays });
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  // 날짜는 사용자가 정한다. 처음엔 한 달 뒤를 채워 두고 고치게 한다
  const [date, setDate] = useState(() => ymd(addDays(seoul(), 30)));
  const add = useMutation({
    mutationFn: () => api.calendar.addDday({ title: title.trim(), date }),
    onError: () => toast('D-day를 추가하지 못했어요. 다시 시도해주세요'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ddays'] });
      setTitle('');
      setAdding(false);
      toast('D-day를 추가했어요');
    },
  });
  const row = (d: DDay) => (
    <View key={d._id} className="flex-row items-center gap-3 border-b border-fill py-4">
      <View className="h-10 w-10 items-center justify-center rounded-full bg-white">
        {(() => {
          const Ic =
            d.source === 'todo'
              ? d.kind === '시험'
                ? Target
                : BookOpen
              : d.daysLeft < 0
                ? PartyPopper
                : d.title === '수능'
                  ? GraduationCap
                  : NotebookPen;
          return <Ic size={ICON.sm} color={C.brand} />;
        })()}
      </View>
      <View className="flex-1">
        <Text className="text-callout font-semibold text-ink">{d.title}</Text>
        <Text className="text-caption text-sub">
          {d.kind} · {d.source === 'todo' ? md(d.date) : d.date.replaceAll('-', '.')}
        </Text>
      </View>
      <Badge tone={d.source === 'todo' ? 'sun' : d.daysLeft < 0 ? 'gray' : 'mint'}>
        {dLabel(d.daysLeft)}
      </Badge>
    </View>
  );
  return (
    <Canvas>
      <Screen>
        <Header title="D-day 관리" sub="과제 · 시험으로 등록한 할 일이 자동으로 올라옵니다." />
        {ddays.isError && !ddays.data && (
          <LoadError message="D-day를 불러오지 못했어요" retry={ddays.refetch} />
        )}
        <Label>할 일에서 자동</Label>
        {ddays.data?.filter((d) => d.source === 'todo').map(row)}
        <Label>직접 등록</Label>
        {ddays.data?.filter((d) => d.source === 'manual').map(row)}
        {adding ? (
          <View className="mt-3 gap-2">
            <Input value={title} onChangeText={setTitle} placeholder="예) 기말고사" autoFocus />
            <View className="flex-row gap-2">
              <Input
                className="flex-1"
                value={date}
                onChangeText={setDate}
                placeholder="YYYY-MM-DD"
                keyboardType="numbers-and-punctuation"
                maxLength={10}
                invalid={!!date && !validYmd(date)}
                accessibilityLabel="D-day 날짜"
              />
              <Btn
                small
                className="w-20"
                disabled={!title.trim() || !validYmd(date)}
                loading={add.isPending}
                onPress={() => add.mutate()}
              >
                추가
              </Btn>
            </View>
            {!!date && !validYmd(date) && (
              <Text className="text-caption text-danger">날짜를 2026-12-24처럼 입력해 주세요</Text>
            )}
          </View>
        ) : (
          <Dashed onPress={() => setAdding(true)}>+ D-day 추가</Dashed>
        )}
      </Screen>
    </Canvas>
  );
}

const DAYS = ['월', '화', '수', '목', '금', '토', '일'];
const dayNum = (i: number) => (i + 1) % 7;

export function RepeatGoalScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const qc = useQueryClient();
  const goals = useQuery({ queryKey: ['goals', 'recurring'], queryFn: api.study.recurringGoals });
  // id가 없으면 새 목표 — 첫 번째 목표를 고치는 화면이 되지 않게 한다
  const g = id ? goals.data?.find((x) => x._id === id) : undefined;
  const [name, setName] = useState('');
  const [days, setDays] = useState<number[]>([]);
  const [min, setMin] = useState(30);
  const [remind, setRemind] = useState(true);
  const [del, setDel] = useState(false);
  // 고칠 목표를 처음 불러왔을 때만 입력값을 채운다 — 재조회가 입력을 덮어쓰지 않게 (렌더 중 상태 조정)
  const [loaded, setLoaded] = useState<string>();
  if (g && g._id !== loaded) {
    setLoaded(g._id);
    setName(g.name);
    setDays(g.days);
    setMin(g.targetMin);
    setRemind(g.remindEnabled);
  }
  const noDays = days.length === 0;
  const save = useMutation({
    mutationFn: () => {
      // 요일이 없으면 저장하지 않는다 (FR-11-04) — 버튼과 별도로 저장 경로에서도 막는다
      if (noDays) throw new Error('요일을 선택해주세요');
      return api.study.saveRecurringGoal({
        ...(g ? { _id: g._id } : {}),
        name,
        days,
        targetMin: min,
        remindEnabled: remind,
        remindTime: '20:00',
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['goals'] });
      router.back();
      toast('반복 목표를 저장했어요');
    },
  });
  const remove = useMutation({
    mutationFn: () => api.study.deleteRecurringGoal(g!._id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['goals'] });
      setDel(false);
      router.back();
      toast('목표를 삭제했어요');
    },
  });
  // 고칠 목표를 못 읽었으면 새 목표 화면으로 넘어가 중복을 만들지 않게 한다
  if (id && goals.isError && !goals.data)
    return (
      <Canvas>
        <Screen>
          <Header title="반복 목표 설정" />
          <LoadError message="반복 목표를 불러오지 못했어요" retry={goals.refetch} />
        </Screen>
      </Canvas>
    );
  return (
    <Canvas>
      <Screen
        footer={
          <>
            {noDays && (
              <Text className="mb-2 text-center text-caption text-danger">요일을 선택해주세요</Text>
            )}
            <Btn
              disabled={noDays || !name.trim()}
              loading={save.isPending}
              onPress={() => save.mutate()}
            >
              저장하기
            </Btn>
            {g && (
              <Pressable onPress={() => setDel(true)} className="mt-3">
                <Text className="text-center text-footnote text-danger">목표 삭제</Text>
              </Pressable>
            )}
          </>
        }
      >
        <Header title="반복 목표 설정" />
        <Label>목표명</Label>
        <Input value={name} onChangeText={setName} placeholder="매일 30분 영어 단어 암기" />
        <Label>반복 요일</Label>
        <View className="flex-row gap-2">
          {DAYS.map((d, i) => {
            const on = days.includes(dayNum(i));
            return (
              <Pressable
                key={d}
                accessibilityRole="checkbox"
                accessibilityLabel={`${d}요일`}
                accessibilityState={{ checked: on }}
                onPress={() =>
                  setDays((p) => (on ? p.filter((x) => x !== dayNum(i)) : [...p, dayNum(i)]))
                }
                className={cx(
                  'h-10 w-10 items-center justify-center rounded-full',
                  on ? 'bg-brand' : 'bg-white',
                )}
              >
                <Text className={cx('text-footnote font-semibold', on ? 'text-white' : 'text-sub')}>
                  {d}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Label>목표 시간</Label>
        <View className="flex-row items-center rounded-2xl bg-white p-2">
          <Pressable
            accessibilityLabel="줄이기"
            onPress={() => setMin((m) => Math.max(10, m - 10))}
            className="h-10 w-10 items-center justify-center rounded-xl bg-fill"
          >
            <Text className="text-title3">−</Text>
          </Pressable>
          <Text className="flex-1 text-center text-headline font-bold text-ink">{min}분</Text>
          <Pressable
            accessibilityLabel="늘리기"
            onPress={() => setMin((m) => m + 10)}
            className="h-10 w-10 items-center justify-center rounded-xl bg-fill"
          >
            <Text className="text-title3">+</Text>
          </Pressable>
        </View>
        <Card tone="white" className="mt-3 flex-row items-center px-4 py-3">
          <View className="flex-1">
            <Text className="text-subhead font-semibold text-ink">리마인드 알림</Text>
            <Text className="text-caption text-sub">고른 요일 20:00에 알려드려요</Text>
          </View>
          <Toggle label="리마인드 알림" on={remind} onChange={setRemind} />
        </Card>
        {g && (
          <View className="mt-3 rounded-xl bg-sun/15 px-3 py-2.5">
            <View className="flex-row items-center gap-1.5">
              <Flame size={ICON.xs} color={C.brand} />
              <Text className="text-footnote text-ink">연속 {g.streak}주 달성 중</Text>
            </View>
          </View>
        )}
        <Alert
          open={del}
          title="반복 목표를 삭제할까요?"
          body="연속 달성 기록도 함께 사라져요."
          secondary="취소"
          onSecondary={() => setDel(false)}
          primary="삭제"
          onPrimary={() => remove.mutate()}
        />
      </Screen>
    </Canvas>
  );
}
