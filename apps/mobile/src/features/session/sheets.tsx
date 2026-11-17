import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/text';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { toast } from '@/stores/toast';
import { Btn, Card, Chip, Input, Label, Loading, Sheet, Toggle } from '@/components/ui';
import { TrendingUp } from 'lucide-react-native';
import { ICON, C } from '@/theme';
import { hm, seoul, ymd } from '@/lib/dates';
import { useNow } from '@/hooks';

// p.47 #2 공부할 항목 추가 / p.49 #7 이번주 목표 시간

// 목표는 시간 단위로 고른다. 저장은 서버 계약대로 분(goalMin)
const GOALS = { '1시간': 60, '2시간': 120, '3시간': 180, '직접 입력': null } as const;
const NEW_SUBJECT = '+ 새 과목';
const MAX_GOAL_HOURS = 24; // 하루 24시간을 넘게 정할 수 없다 (FR-06-23)

/** 바텀시트 입력을 저장할 값으로 바꾼다. 잘못된 입력이면 안내 문구를 돌려준다 */
export function itemInput(p: {
  title: string;
  subject: string;
  newSubject: string;
  goal: keyof typeof GOALS | null;
  customHours: string;
}): { title: string; subjectName: string; goalMin: number | null } | string {
  const title = p.title.trim();
  if (!title) return '공부할 내용을 입력해 주세요';
  const subjectName = (p.subject === NEW_SUBJECT ? p.newSubject : p.subject).trim();
  if (!subjectName) return '과목 이름을 입력해 주세요';
  if (subjectName.length > 20) return '과목 이름은 20자까지 쓸 수 있어요';
  if (p.goal !== '직접 입력') return { title, subjectName, goalMin: p.goal ? GOALS[p.goal] : null };
  const h = Number(p.customHours);
  if (!p.customHours || !Number.isInteger(h) || h < 1 || h > MAX_GOAL_HOURS)
    return `목표 시간은 1 ~ ${MAX_GOAL_HOURS}시간으로 입력해 주세요`;
  return { title, subjectName, goalMin: h * 60 };
}

export function AddItemSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const subjects = useQuery({ queryKey: ['subjects'], queryFn: api.study.subjects });
  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('');
  const [newSubject, setNewSubject] = useState('');
  // 목표 시간은 생략할 수 있다 (FR-06-01) — 같은 칩을 다시 누르면 해제
  const [goal, setGoal] = useState<keyof typeof GOALS | null>(null);
  const [customHours, setCustomHours] = useState('');
  const input = itemInput({ title, subject, newSubject, goal, customHours });
  const add = useMutation({
    mutationFn: () => {
      if (typeof input === 'string') throw new Error(input);
      return api.study.addItem(input);
    },
    onError: () => toast('항목을 추가하지 못했어요. 다시 시도해주세요'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['study', 'today'] });
      qc.invalidateQueries({ queryKey: ['subjects'] });
      setTitle('');
      setNewSubject('');
      onClose();
    },
  });
  const names = (subjects.data ?? []).slice(0, 4).map((s) => s.name);
  return (
    <Sheet open={open} onClose={onClose}>
      <Text className="text-headline font-bold text-ink">공부할 항목 추가</Text>
      <Text className="text-caption text-sub">추가한 항목마다 순공시간이 따로 쌓여요</Text>
      <Label>무엇을 공부하나요?</Label>
      <Input
        value={title}
        onChangeText={setTitle}
        placeholder="이차방정식 풀이"
        autoFocus
        returnKeyType="done"
      />
      <Label>과목</Label>
      <View className="flex-row flex-wrap gap-2">
        {[...names, NEW_SUBJECT].map((x) => (
          <Chip key={x} on={subject === x} onPress={() => setSubject(x)}>
            {x}
          </Chip>
        ))}
      </View>
      {subject === NEW_SUBJECT && (
        <Input
          className="mt-2"
          value={newSubject}
          onChangeText={setNewSubject}
          placeholder="새 과목 이름 (20자까지)"
          maxLength={20}
        />
      )}
      <Label>오늘 목표 시간 (선택)</Label>
      <View className="flex-row flex-wrap gap-2">
        {(Object.keys(GOALS) as (keyof typeof GOALS)[]).map((x) => (
          <Chip key={x} on={goal === x} onPress={() => setGoal(goal === x ? null : x)}>
            {x}
          </Chip>
        ))}
      </View>
      {goal === '직접 입력' && (
        <Input
          className="mt-2"
          value={customHours}
          onChangeText={(v) => setCustomHours(v.replace(/[^0-9]/g, ''))}
          placeholder="목표 시간 (시간)"
          keyboardType="number-pad"
          maxLength={2}
          right={<Text className="text-footnote text-sub">시간</Text>}
        />
      )}
      {typeof input === 'string' && (title || subject === NEW_SUBJECT || goal === '직접 입력') && (
        <Text className="mt-2 text-caption text-danger">{input}</Text>
      )}
      <Btn
        className="mt-6"
        disabled={typeof input === 'string'}
        loading={add.isPending}
        onPress={() => add.mutate()}
      >
        추가하기
      </Btn>
    </Sheet>
  );
}

const Step = ({ label, d, onPress }: { label: string; d: number; onPress: () => void }) => (
  <Pressable
    accessibilityLabel={label}
    onPress={onPress}
    className="h-10 w-10 items-center justify-center rounded-xl bg-fill"
  >
    <Text className="text-title3 text-ink">{d < 0 ? '−' : '+'}</Text>
  </Pressable>
);

export function WeekGoalSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const day = ymd(seoul(useNow()));
  const goal = useQuery({
    queryKey: ['goal', 'weekly', day],
    queryFn: api.study.weeklyGoal,
    enabled: open,
    refetchOnMount: 'always',
  });
  const [h, setH] = useState(21);
  const [manual, setManual] = useState(false);
  const [inputH, setInputH] = useState('21');
  const hours = manual ? Number(inputH) : h;
  const valid = Number.isFinite(hours) && hours >= 1 && hours <= 168 && Number.isInteger(hours * 2);
  const [alarm, setAlarm] = useState(true);
  const [loaded, setLoaded] = useState<{ day: string; error: boolean } | null>(null);
  const [observed, setObserved] = useState({ open, day });
  if (observed.open !== open || observed.day !== day) {
    setObserved({ open, day });
    setLoaded(null);
  }
  const loadVersion = useRef(0);
  const load = () => {
    const version = ++loadVersion.current;
    return goal.refetch().then((result) => {
      if (version !== loadVersion.current) return;
      if (!result.isSuccess) {
        setLoaded({ day, error: true });
        return;
      }
      setH(result.data.targetMin / 60);
      setInputH(String(result.data.targetMin / 60));
      setAlarm(result.data.notify80);
      setManual(false);
      setLoaded({ day, error: false });
    });
  };
  useEffect(() => {
    const generation = loadVersion;
    if (open) void load();
    return () => {
      generation.current++;
    };
  }, [open, day]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = loaded?.day === day && !loaded.error;
  const save = useMutation({
    mutationFn: () => {
      if (!valid) throw new Error('목표 범위를 확인해주세요');
      return api.study.setWeeklyGoal({ targetMin: hours * 60, notify80: alarm });
    },
    onError: () => toast('목표를 저장하지 못했어요. 다시 시도해주세요'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['goal'] });
      onClose();
      toast(`이번주 목표를 ${hours}시간으로 정했어요`);
    },
  });
  if (open && !ready)
    return (
      <Sheet open={open} onClose={onClose}>
        {loaded?.error ? (
          <>
            <Text>목표를 불러오지 못했어요</Text>
            <Btn
              onPress={() => {
                setLoaded(null);
                void load();
              }}
            >
              다시 시도
            </Btn>
          </>
        ) : (
          <Loading />
        )}
      </Sheet>
    );
  return (
    <Sheet open={open} onClose={onClose}>
      <Text className="text-headline font-bold text-ink">이번주 목표 시간</Text>
      <Text className="text-caption text-sub">월요일마다 새로 시작돼요</Text>
      <View className="mt-4 flex-row items-center rounded-2xl border border-brand/40 p-2">
        <Step
          label="줄이기"
          d={-0.5}
          onPress={() => {
            setManual(false);
            setH((x) => Math.max(1, x - 0.5));
          }}
        />
        <Text className="flex-1 text-center text-title1 font-bold text-ink">{h}시간</Text>
        <Step
          label="늘리기"
          d={0.5}
          onPress={() => {
            setManual(false);
            setH((x) => Math.min(168, x + 0.5));
          }}
        />
      </View>
      <Text className="mt-2 text-caption text-sub">
        30분 단위로 조절돼요 · 하루 평균 {Math.round((h / 7) * 10) / 10}시간
      </Text>
      <Label>빠른 선택</Label>
      <View className="flex-row gap-2">
        {[14, 21, 28].map((x) => (
          <View key={x} className="flex-1">
            <Chip
              on={!manual && h === x}
              onPress={() => {
                setManual(false);
                setH(x);
              }}
            >{`${x}시간`}</Chip>
          </View>
        ))}
        <View className="flex-1">
          <Chip
            onPress={() => {
              setInputH(String(h));
              setManual(true);
            }}
          >
            직접 입력
          </Chip>
        </View>
      </View>
      {manual && (
        <Input
          placeholder="목표 시간"
          value={inputH}
          onChangeText={setInputH}
          keyboardType="decimal-pad"
        />
      )}
      {!valid && <Text>1~168시간을 30분 단위로 입력해주세요</Text>}
      <View className="mt-4 rounded-xl bg-sun/15 px-3 py-2.5">
        <View className="flex-row items-center gap-1.5">
          <TrendingUp size={ICON.xs} color={C.brand} />
          <Text className="text-caption text-ink">
            최근 4주 평균은 {hm((goal.data?.recentAvgMin ?? 0) * 60)}이에요
          </Text>
        </View>
      </View>
      <Card className="mt-3 flex-row items-center px-4 py-3">
        <View className="flex-1">
          <Text className="text-subhead font-semibold text-ink">목표 달성 알림</Text>
          <Text className="text-caption text-sub">80%를 넘으면 알려드려요</Text>
        </View>
        <Toggle label="목표 달성 알림" on={alarm} onChange={setAlarm} />
      </Card>
      <Btn
        className="mt-5"
        disabled={!valid || goal.isFetching || !goal.data}
        loading={save.isPending}
        onPress={() => save.mutate()}
      >
        저장하기
      </Btn>
    </Sheet>
  );
}
