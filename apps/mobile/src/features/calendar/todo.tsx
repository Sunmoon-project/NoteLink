import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/text';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Check } from 'lucide-react-native';
import type { Todo, TodoType } from '@notelink/shared';
import { api } from '@/lib/api';
import { md, today } from '@/lib/dates';
import { toast } from '@/stores/toast';
import { Badge, Btn, Chip, Dashed, Input, Label, Sheet, cx } from '@/components/ui';
import { ICON, C } from '@/theme';
import { LoadError } from '../progress/load-error';

// p.50 #11 날짜별 할 일 / p.51 #12 할 일 추가

const slotLabel = (t: Todo) =>
  t.timeSlot === 'none'
    ? '시간 미정'
    : t.dueTime
      ? t.dueTime
      : t.timeSlot === 'am'
        ? '오전'
        : '오후';

export function TodoSheet({
  open,
  date,
  onClose,
  onAdd,
}: {
  open: boolean;
  date: string;
  onClose: () => void;
  onAdd: () => void;
}) {
  const qc = useQueryClient();
  const todos = useQuery({
    queryKey: ['todos', date],
    queryFn: () => api.calendar.todos(date),
    enabled: open,
  });
  const toggle = useMutation({
    mutationFn: (t: Todo) => api.calendar.toggleTodo(t._id, !t.done),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['todos', date] }),
    onError: () => toast('할 일을 저장하지 못했어요. 다시 시도해 주세요'),
  });
  const list = todos.data ?? [];
  return (
    <Sheet open={open} onClose={onClose}>
      <View className="flex-row items-center justify-between">
        <Text className="text-headline font-bold text-ink">{md(date)}</Text>
        {date === today() && <Badge>오늘</Badge>}
      </View>
      <Text className="text-caption text-sub">
        할 일 {list.length}개 · {list.filter((t) => t.done).length}개 완료
      </Text>
      <View className="mt-3 gap-2">
        {todos.isError && !todos.data && (
          <LoadError message="할 일을 불러오지 못했어요" retry={todos.refetch} />
        )}
        {todos.isSuccess && list.length === 0 && (
          <Text className="py-6 text-center text-footnote text-sub">이 날은 할 일이 없어요</Text>
        )}
        {list.map((t) => (
          <Pressable
            key={t._id}
            disabled={toggle.isPending}
            onPress={() => toggle.mutate(t)}
            className="flex-row items-center gap-3 rounded-2xl border border-line px-4 py-3"
          >
            <View
              className={cx(
                'h-6 w-6 items-center justify-center rounded-md border',
                t.done ? 'border-brand bg-brand' : 'border-cream-2',
              )}
            >
              {t.done && <Check size={ICON.xs} color="#fff" />}
            </View>
            <View>
              <Text className={cx('text-subhead', t.done ? 'text-sub line-through' : 'text-ink')}>
                {t.content}
              </Text>
              <Text className="text-caption2 text-sub">
                {t.subjectName ?? '일반'} · {slotLabel(t)}
              </Text>
            </View>
          </Pressable>
        ))}
      </View>
      <Dashed onPress={onAdd}>+ 할 일 추가</Dashed>
    </Sheet>
  );
}

const TYPES: [TodoType, string][] = [
  ['general', '일반'],
  ['assignment', '과제'],
  ['exam', '시험'],
];
const SLOTS: [Todo['timeSlot'], string][] = [
  ['none', '시간 미정'],
  ['am', '오전'],
  ['pm', '오후'],
  ['custom', '직접 입력'],
];

export function AddTodoSheet({
  open,
  date,
  onClose,
}: {
  open: boolean;
  date: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const subjects = useQuery({ queryKey: ['subjects'], queryFn: api.study.subjects });
  const [content, setContent] = useState('');
  const [type, setType] = useState<TodoType>('assignment');
  const [dueTime, setDueTime] = useState('');
  const validTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(dueTime);
  const [slot, setSlot] = useState<Todo['timeSlot']>('none');
  const [subj, setSubj] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () =>
      api.calendar.addTodo({
        content: content.trim(),
        todoType: type,
        dueDate: date,
        timeSlot: slot,
        ...(slot === 'custom' ? { dueTime } : {}),
        subjectName: subj,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['todos'] });
      qc.invalidateQueries({ queryKey: ['ddays'] });
      qc.invalidateQueries({ queryKey: ['study', 'month'] });
      toast(type === 'general' ? '할 일을 추가했어요' : '할 일을 추가하고 홈 D-day에 표시했어요');
      setContent('');
      onClose();
    },
  });
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="할 일 추가"
      right={
        <Pressable onPress={onClose} hitSlop={10}>
          <Text className="text-footnote text-sub">취소</Text>
        </Pressable>
      }
    >
      <Text className="-mt-2 text-caption text-sub">
        과제 · 시험으로 고르면 홈 화면에 D-day로 표시돼요
      </Text>
      <Label>할 일</Label>
      <Input
        value={content}
        onChangeText={(v) => setContent(v.slice(0, 40))}
        placeholder="수학 워크북 3단원 제출"
        right={`${content.length}/40`}
        autoFocus
      />
      <Label>유형</Label>
      <View className="flex-row gap-2">
        {TYPES.map(([k, l]) => (
          <Chip key={k} on={type === k} onPress={() => setType(k)}>
            {l}
          </Chip>
        ))}
      </View>
      <Label>날짜</Label>
      <View className="h-12 flex-row items-center rounded-xl border border-line px-4">
        <View className="flex-1 flex-row items-center gap-1.5">
          <CalendarDays size={ICON.sm} color={C.sub} />
          <Text className="text-subhead text-ink">{md(date)}</Text>
        </View>
      </View>
      <Label>시간 (선택)</Label>
      <View className="flex-row flex-wrap gap-2">
        {SLOTS.map(([k, l]) => (
          <Chip key={k} on={slot === k} onPress={() => setSlot(k)}>
            {l}
          </Chip>
        ))}
      </View>
      {slot === 'custom' && (
        <Input
          placeholder="HH:MM (24시간)"
          value={dueTime}
          onChangeText={setDueTime}
          keyboardType="numbers-and-punctuation"
        />
      )}
      <Label>과목 (선택)</Label>
      <View className="flex-row flex-wrap gap-2">
        <Chip on={subj === null} onPress={() => setSubj(null)}>
          없음
        </Chip>
        {(subjects.data ?? []).slice(0, 4).map((s) => (
          <Chip key={s._id} on={subj === s.name} onPress={() => setSubj(s.name)}>
            {s.name}
          </Chip>
        ))}
      </View>
      <Btn
        className="mt-6"
        disabled={!content.trim() || (slot === 'custom' && !validTime)}
        loading={add.isPending}
        onPress={() => add.mutate()}
      >
        추가하기
      </Btn>
    </Sheet>
  );
}
