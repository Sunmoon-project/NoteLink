import { useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import { Text, TextInput } from '@/components/text';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as ImagePicker from 'expo-image-picker';
import * as Calendar from 'expo-calendar';
import * as Clipboard from 'expo-clipboard';
import {
  ArrowLeft,
  Bell,
  CalendarDays,
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  Copy,
  HelpCircle,
  KeyRound,
  Lock,
  Pencil,
  Settings,
  Sparkles,
  Timer,
  UserPlus,
} from 'lucide-react-native';
import type { ReportType, TimerRule } from '@notelink/shared';
import { api } from '@/lib/api';
import { uploadToBlob } from '@/lib/upload';
import { addDays, seoul, ymd, WD } from '@/lib/dates';
import { toast } from '@/stores/toast';
import {
  Alert,
  Avatar,
  Badge,
  Btn,
  Dialog,
  Group,
  Header,
  Label,
  Row,
  Screen,
  Search,
  Sheet,
  Toggle,
  Two,
  cx,
} from '@/components/ui';
import { useAuth } from '@/stores/auth';
import { C, ICON } from '@/theme';

// p.78 신고 / p.79 타이머 / p.80 시간표 · OS 캘린더 / p.81 세부 설정 · 초대 · 나가기

const REPORT_TYPES: [ReportType, string][] = [
  ['abusive_language', '부적절한 언어 사용'],
  ['spam', '스팸 · 광고'],
  ['disturbing', '학습 방해'],
  ['obscene', '음란 · 불쾌한 콘텐츠'],
  ['other', '기타'],
];

export const MIN_REPORT_CHARS = 10;
export const MAX_REPORT_PHOTOS = 5;
/** 신고 대상 · 유형(필수) · 내용 10자 이상을 채워야 보낼 수 있다 (FR-33-02 · 03) */
export const reportReady = (p: { target?: string; type: ReportType | null; body: string }) =>
  !!p.target && !!p.type && p.body.trim().length >= MIN_REPORT_CHARS;

export function ReportScreen() {
  const { id, target: picked } = useLocalSearchParams<{ id: string; target?: string }>();
  const myId = useAuth((s) => s.userId);
  const room = useQuery({ queryKey: ['room', id], queryFn: () => api.rooms.get(id) });
  // 신고 대상은 이 방의 다른 멤버 중에서만 고른다. 방에서 사람을 골라 들어오면 그 사람이 기본값
  const others = (room.data?.members ?? []).filter((m) => m.userId !== myId);
  const [chosen, setChosen] = useState<string | undefined>(picked);
  const t = others.find((m) => m.userId === chosen);
  const target = t ? { id: t.userId, name: t.nickname } : null;
  const [type, setType] = useState<ReportType | null>(null);
  const [body, setBody] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [sheet, setSheet] = useState<null | 'target' | 'type'>(null);
  const [done, setDone] = useState(false);
  const addPhoto = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7 });
    const uri = r.canceled ? undefined : r.assets[0]?.uri;
    if (uri) setPhotos((p) => [...p, uri].slice(0, MAX_REPORT_PHOTOS));
  };
  const send = useMutation({
    mutationFn: async () => {
      if (!target || !reportReady({ target: target.id, type, body }))
        throw new Error('입력을 확인해 주세요');
      const urls = await Promise.all(
        photos.map((uri, i) =>
          uploadToBlob('image', { uri, name: `report_${i}.jpg`, mimeType: 'image/jpeg' }),
        ),
      );
      await api.rooms.report({
        roomId: id,
        targetUserId: target.id,
        reportType: type!,
        details: body,
        imageUrls: urls,
      });
    },
    onError: () => toast('신고를 보내지 못했어요. 입력을 유지했으니 다시 시도해주세요'),
    onSuccess: () => setDone(true),
  });
  return (
    <View className="flex-1">
      <Screen
        footer={
          <Btn
            disabled={!reportReady({ target: target?.id, type, body })}
            loading={send.isPending}
            onPress={() => send.mutate()}
          >
            신고하기
          </Btn>
        }
      >
        <Header title="신고" center />
        <View className="rounded-2xl border border-line p-4">
          <Text className="mb-1.5 text-caption text-sub">신고 대상</Text>
          <Pressable
            onPress={() => setSheet('target')}
            className="flex-row items-center gap-3 rounded-xl bg-cream px-3 py-2.5"
          >
            {target ? (
              <>
                <Avatar name={target.name} size={30} />
                <Text className="flex-1 text-footnote font-semibold text-ink">{target.name}</Text>
              </>
            ) : (
              <Text className="flex-1 text-footnote text-sub">신고할 사람을 골라 주세요</Text>
            )}
            <ChevronDown size={ICON.sm} color={C.sub} />
          </Pressable>
          <Text className="mt-4 mb-1.5 text-caption text-sub">신고 유형 선택</Text>
          <Pressable
            onPress={() => setSheet('type')}
            className="h-11 flex-row items-center justify-between rounded-xl bg-cream px-3"
          >
            <Text className={cx('text-footnote', type ? 'text-ink' : 'text-sub')}>
              {REPORT_TYPES.find((x) => x[0] === type)?.[1] ?? '신고 유형을 골라 주세요'}
            </Text>
            <ChevronDown size={ICON.sm} color={C.sub} />
          </Pressable>
          <Text className="mt-4 mb-1.5 text-caption text-sub">신고 내용</Text>
          <TextInput
            multiline
            value={body}
            onChangeText={setBody}
            placeholder="신고 사유를 자세히 입력해 주세요. (10자 이상)"
            placeholderTextColor={C.sub}
            className="h-32 rounded-xl bg-cream p-3 text-footnote text-ink"
            style={{ textAlignVertical: 'top' }}
          />
          <Text
            className={cx(
              'mt-1 text-right text-caption2',
              body.trim().length < MIN_REPORT_CHARS ? 'text-danger' : 'text-sub',
            )}
          >
            {body.trim().length}/{MIN_REPORT_CHARS}자 이상
          </Text>
          <Text className="mt-4 mb-1.5 text-caption text-sub">사진 첨부</Text>
          <View className="flex-row gap-2">
            {photos.map((u) => (
              <Image key={u} source={{ uri: u }} className="h-14 w-14 rounded-xl" />
            ))}
            {photos.length < MAX_REPORT_PHOTOS && (
              <Pressable
                onPress={addPhoto}
                className="h-14 w-14 items-center justify-center rounded-xl border border-line"
              >
                <Camera size={ICON.sm} color={C.sub} />
                <Text className="text-caption2 text-sub">
                  {photos.length}/{MAX_REPORT_PHOTOS}
                </Text>
              </Pressable>
            )}
          </View>
          <View className="mt-4 rounded-xl bg-mint/60 p-3">
            <Text className="mb-1 text-caption2 font-semibold text-ink">신고 안내</Text>
            {[
              '• 허위 신고 시 이용이 제한될 수 있습니다.',
              '• 신고는 검토 후 처리되며 1~3일이 소요됩니다.',
              '• 긴급 상황은 고객센터로 문의해 주세요.',
            ].map((t) => (
              <Text key={t} className="text-caption2 text-sub">
                {t}
              </Text>
            ))}
          </View>
        </View>
      </Screen>
      <Sheet open={sheet === 'target'} onClose={() => setSheet(null)} title="신고 대상">
        <Group>
          {others.map((m) => (
            <Row
              key={m.userId}
              onPress={() => {
                setChosen(m.userId);
                setSheet(null);
              }}
              right={target?.id === m.userId && <Check size={ICON.sm} color={C.brand} />}
            >
              {m.nickname}
            </Row>
          ))}
        </Group>
      </Sheet>
      <Sheet open={sheet === 'type'} onClose={() => setSheet(null)} title="신고 유형">
        <Group>
          {REPORT_TYPES.map(([k, l]) => (
            <Row
              key={k}
              onPress={() => {
                setType(k);
                setSheet(null);
              }}
              right={type === k && <Check size={ICON.sm} color={C.brand} />}
            >
              {l}
            </Row>
          ))}
        </Group>
      </Sheet>
      <Dialog open={done}>
        <Text className="text-body font-bold text-ink">신고 완료</Text>
        <Text className="mt-1 text-caption text-sub">검토 후 1~3일 안에 결과를 알려드려요</Text>
        <Btn
          small
          kind="outline"
          className="mt-4 w-full"
          onPress={() => {
            setDone(false);
            router.back();
          }}
        >
          확인
        </Btn>
      </Dialog>
    </View>
  );
}

const PERIODS = [
  { start: '09:00', end: '09:50', label: '수학 문제풀이' },
  { start: '10:00', end: '10:50', label: '영어 독해' },
  { start: '11:00', end: '11:50', label: '자율 학습' },
];

export function TimerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const qc = useQueryClient();
  const room = useQuery({ queryKey: ['room', id], queryFn: () => api.rooms.get(id) });
  const [on, setOn] = useState(true);
  const [type, setType] = useState<TimerRule['type']>('pomodoro');
  const [focus, setFocus] = useState('50');
  const [rest, setRest] = useState('10');
  const [repeat, setRepeat] = useState(4);
  const [periods, setPeriods] = useState<TimerRule['periods']>(PERIODS);
  const [help, setHelp] = useState(false);
  // 방의 시간 규칙을 처음 불러왔을 때만 입력값을 채운다 — 재조회가 입력을 덮어쓰지 않게 (렌더 중 상태 조정)
  const r = room.data?.timerRule;
  const [loaded, setLoaded] = useState(false);
  if (r && !loaded) {
    setLoaded(true);
    setOn(r.enabled);
    setType(r.type);
    setFocus(String(r.focusMin));
    setRest(String(r.breakMin));
    setRepeat(r.repeat);
    setPeriods(r.periods);
  }
  const preset = `${focus}/${rest}`;
  const save = useMutation({
    mutationFn: () => {
      if (!room.data) throw new Error('방 설정을 먼저 불러와 주세요');
      return api.rooms.setTimer(id, {
        enabled: on,
        type,
        focusMin: Number(focus) || 50,
        breakMin: Number(rest) || 10,
        repeat,
        periods,
      });
    },
    onError: () => toast('타이머를 저장하지 못했어요. 다시 시도해주세요'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['room', id] });
      router.back();
      toast(on ? '모든 참여자에게 타이머를 적용했어요' : '타이머를 껐어요');
    },
  });
  return (
    <View className="flex-1">
      <Screen
        footer={
          <Btn disabled={!room.data} loading={save.isPending} onPress={() => save.mutate()}>
            저장하기
          </Btn>
        }
      >
        <View className="flex-row items-center gap-3 pt-3">
          <Pressable
            accessibilityLabel="뒤로"
            onPress={() => router.back()}
            className="h-9 w-9 items-center justify-center rounded-full bg-cream"
          >
            <ChevronLeft size={ICON.md} color={C.ink} />
          </Pressable>
          <View className="flex-1">
            <Text className="text-body font-bold text-ink">방 시간 규칙</Text>
            <Text className="text-caption2 text-sub">방장 전용 · 멤버 전원</Text>
          </View>
          <Pressable accessibilityLabel="도움말" onPress={() => setHelp(true)}>
            <HelpCircle size={ICON.md} color={C.sub} />
          </Pressable>
        </View>
        <View className="mt-5 flex-row items-start justify-between">
          <View className="flex-1">
            <Text className="text-headline font-bold text-ink">함께 공부할 리듬을 정해요</Text>
            <Text className="text-caption text-sub">
              설정한 시간은 모든 참여자에게 동시에 적용돼요.
            </Text>
          </View>
          <Toggle label="방 시간 규칙" on={on} onChange={setOn} />
        </View>
        <View className={cx(!on && 'opacity-40')} pointerEvents={on ? 'auto' : 'none'}>
          <Label>
            <Text className="text-footnote font-bold text-ink">규칙 유형</Text>
          </Label>
          <View className="flex-row gap-2">
            {(
              [
                ['pomodoro', '뽀모도로', '집중과 휴식 반복', Timer],
                ['period', '교시제', '정해진 시간표', CalendarDays],
              ] as const
            ).map(([k, t, d, Ic]) => (
              <Pressable
                key={k}
                onPress={() => setType(k)}
                className={cx(
                  'flex-1 flex-row items-center gap-2 rounded-xl border px-3 py-3',
                  type === k ? 'border-brand/40 bg-mint' : 'border-line',
                )}
              >
                <Ic size={ICON.md} color={C.brand} />
                <View className="flex-1">
                  <Text className="text-footnote font-semibold text-ink">{t}</Text>
                  <Text className="text-caption2 text-sub">{d}</Text>
                </View>
                <View
                  className={cx(
                    'h-2 w-2 rounded-full',
                    type === k ? 'bg-brand' : 'border border-cream-2',
                  )}
                />
              </Pressable>
            ))}
          </View>
          {type === 'pomodoro' && (
            <>
              <Label>
                <View>
                  <Text className="text-footnote font-bold text-ink">뽀모도로 프리셋</Text>
                  <Text className="text-caption2 text-sub">자주 쓰는 집중 리듬을 선택하세요</Text>
                </View>
              </Label>
              <View className="flex-row gap-2">
                {(
                  [
                    ['50/10', '깊은 집중'],
                    ['25/5', '기본 루틴'],
                    ['90/20', '몰입 학습'],
                  ] as const
                ).map(([p, d]) => (
                  <Pressable
                    key={p}
                    onPress={() => {
                      const [f = '50', r = '10'] = p.split('/');
                      setFocus(f);
                      setRest(r);
                    }}
                    className={cx(
                      'flex-1 rounded-xl border px-3 py-2.5',
                      preset === p ? 'border-brand/40 bg-mint' : 'border-line',
                    )}
                  >
                    <Text className="text-subhead font-bold text-ink">{p.replace('/', ' / ')}</Text>
                    <Text className="text-caption2 text-sub">{d}</Text>
                  </Pressable>
                ))}
              </View>
              <View className="mt-3 rounded-xl bg-cream p-3">
                <View className="flex-row justify-between">
                  <View className="flex-row items-center gap-1.5">
                    <Settings size={ICON.xs} color={C.brand} />
                    <Text className="text-caption font-bold text-ink">직접 설정</Text>
                  </View>
                  <Text className="text-caption text-brand">4회 반복</Text>
                </View>
                <View className="mt-2 flex-row gap-2">
                  {(
                    [
                      ['집중 시간', focus, setFocus],
                      ['휴식 시간', rest, setRest],
                    ] as const
                  ).map(([l, v, set]) => (
                    <View key={l} className="flex-1">
                      <Text className="text-caption2 text-sub">{l}</Text>
                      <View className="mt-1 h-10 flex-row items-center rounded-lg bg-white px-3">
                        <TextInput
                          value={v}
                          onChangeText={(t) => set(t.replace(/\D/g, ''))}
                          keyboardType="number-pad"
                          className="flex-1 text-subhead text-ink"
                        />
                        <Text className="text-caption text-sub">분</Text>
                      </View>
                    </View>
                  ))}
                </View>
              </View>
            </>
          )}
          <Label
            right={
              <Pressable
                onPress={() => toast('교시 시간을 눌러 바꿀 수 있어요')}
                className="rounded-full border border-brand/40 px-2 py-0.5"
              >
                <Text className="text-caption2 text-brand">시간표 편집</Text>
              </Pressable>
            }
          >
            <View>
              <Text className="text-footnote font-bold text-ink">교시별 시간표</Text>
              <Text className="text-caption2 text-sub">교시제로 전환할 때 사용할 시간표예요</Text>
            </View>
          </Label>
          <View className="gap-1.5 rounded-2xl bg-cream p-2">
            {periods.map((p, i) => (
              <View
                key={p.start}
                className={cx(
                  'flex-row items-center gap-3 rounded-xl px-3 py-2.5',
                  i === 0 ? 'bg-mint' : 'bg-white',
                )}
              >
                <View
                  className={cx(
                    'h-7 w-7 items-center justify-center rounded-full',
                    i === 0 ? 'bg-brand' : 'bg-cream',
                  )}
                >
                  <Text
                    className={cx('text-caption font-bold', i === 0 ? 'text-white' : 'text-ink')}
                  >
                    {i + 1}
                  </Text>
                </View>
                <View className="flex-1">
                  <Text className="text-footnote font-semibold text-ink">
                    {p.start} - {p.end}
                  </Text>
                  <Text className="text-caption2 text-sub">{p.label}</Text>
                </View>
                <Pencil size={ICON.md} color={C.brand} />
              </View>
            ))}
          </View>
          <Label>
            <Text className="text-footnote font-bold text-ink">적용 일정 미리보기</Text>
          </Label>
          <View className="rounded-xl bg-cream px-3 py-2.5">
            <Text className="text-caption text-sub">
              {type === 'pomodoro'
                ? `집중 ${focus}분 → 휴식 ${rest}분 × ${repeat}회 · 총 ${(Number(focus) + Number(rest)) * repeat}분`
                : `${periods.length}교시 · ${periods[0]?.start ?? ''} → ${periods.at(-1)?.end ?? ''}`}
            </Text>
          </View>
        </View>
      </Screen>
      <Alert
        open={help}
        tone="brand"
        icon="?"
        title="방 시간 규칙"
        body="방장이 정한 집중 · 휴식 시간이 모든 참여자의 화면에 함께 표시돼요."
        primary="알겠어요"
        onPrimary={() => setHelp(false)}
      />
    </View>
  );
}

export function ScheduleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const room = useQuery({ queryKey: ['room', id], queryFn: () => api.rooms.get(id) });
  const sch = useQuery({ queryKey: ['room-schedule', id], queryFn: () => api.rooms.schedule(id) });
  // 기기 캘린더에 이벤트 추가 — OS 기본 "새로운 이벤트" 화면을 띄운다 (p.80 #17)
  const addToCalendar = async (day: string, start: string, end: string) => {
    const perm = await Calendar.requestCalendarPermissionsAsync();
    if (!perm.granted) return toast('캘린더 권한을 허용하면 일정을 추가할 수 있어요');
    const target = WD.indexOf(day.trim().slice(0, 1));
    if (target < 0) return toast('일정의 요일을 확인해주세요');
    const now = seoul();
    const d = addDays(now, (target - now.getDay() + 7) % 7 || 7);
    const at = (t: string) => new Date(`${ymd(d)}T${t.padStart(5, '0')}:00+09:00`);
    const r = await Calendar.createEventInCalendarAsync({
      title: `${room.data?.title ?? '스터디룸'} 공동 학습`,
      startDate: at(start),
      endDate: at(end),
      notes: '노트링크 스터디룸에서 함께 공부해요',
    });
    if (r.action === 'saved') toast('기기 캘린더에 일정을 추가했어요');
  };
  const s = sch.data;
  return (
    <Screen>
      <View className="h-12 flex-row items-center gap-2 pt-2">
        <Pressable accessibilityLabel="뒤로" onPress={() => router.back()} hitSlop={10}>
          <ArrowLeft size={ICON.lg} color={C.ink} />
        </Pressable>
        <Text className="flex-1 text-headline font-bold text-ink">시간표</Text>
        <Pressable
          onPress={() =>
            s?.matches[0] && addToCalendar(s.matches[0].day, s.matches[0].start, s.matches[0].end)
          }
          className="rounded-full bg-mint px-3 py-1"
        >
          <Text className="text-caption2 font-semibold text-brand">캘린더</Text>
        </Pressable>
        <Settings size={ICON.md} color={C.sub} />
      </View>
      <View className="mt-2 flex-row items-center rounded-2xl bg-mint p-4">
        <View className="flex-1">
          <Text className="text-caption2 text-sub">{room.data?.title}</Text>
          <Text className="text-body font-bold text-ink">이번 주 공동 학습 가능 시간 조율</Text>
        </View>
        <Badge tone="gray">{`${s?.members.length ?? 0}명 연동중`}</Badge>
      </View>
      <Text className="mt-4 mb-2 text-caption text-sub">스터디룸 멤버 일정 현황</Text>
      <View className="flex-row flex-wrap gap-1.5">
        {s?.members.map((m) => (
          <View key={m.nickname} className="rounded-full bg-cream px-2.5 py-1">
            <Text className="text-caption2 text-ink">
              {m.emoji} {m.nickname}
            </Text>
          </View>
        ))}
      </View>
      <View className="mt-3 rounded-2xl border border-line p-3">
        <View className="flex-row pl-9">
          {['월', '화', '수', '목', '금', '토', '일'].map((d) => (
            <Text key={d} className="flex-1 text-center text-caption2 text-sub">
              {d}
            </Text>
          ))}
        </View>
        {s?.grid.map((row, r) => (
          <View key={r} className="mt-1 flex-row items-center">
            <Text className="w-9 text-caption2 text-sub">{s.startHour + r}:00</Text>
            {row.map((c, i) => (
              <Pressable
                key={i}
                accessibilityLabel={`${['월', '화', '수', '목', '금', '토', '일'][i]} ${s.startHour + r}:00 일정 추가`}
                disabled={c !== 2}
                onPress={() =>
                  addToCalendar(
                    ['월', '화', '수', '목', '금', '토', '일'][i]!,
                    `${s.startHour + r}:00`,
                    `${s.startHour + r + 1}:00`,
                  )
                }
                className={cx(
                  'mx-0.5 h-6 flex-1 items-center justify-center rounded-md',
                  c === 2 ? 'border border-brand bg-mint' : c === 1 ? 'bg-cream-2' : 'bg-cream',
                )}
              >
                {c === 2 && <Sparkles size={ICON.md} color={C.brand} />}
              </Pressable>
            ))}
          </View>
        ))}
      </View>
      <View className="mt-3 rounded-2xl border border-line p-3">
        <View className="flex-row items-center gap-1.5">
          <Sparkles size={ICON.xs} color={C.brand} />
          <Text className="text-footnote font-bold text-ink">실시간 매칭된 공통 가능 시간</Text>
        </View>
        {s?.matches.map((m) => (
          <Pressable
            key={m.label}
            onPress={() => addToCalendar(m.day, m.start, m.end)}
            className={cx(
              'mt-2 flex-row items-center rounded-xl px-3 py-2.5',
              m.best ? 'bg-mint' : 'bg-cream',
            )}
          >
            <View className="flex-1">
              <Text
                className={cx('text-footnote font-semibold', m.best ? 'text-brand' : 'text-ink')}
              >
                {m.label}
              </Text>
              <Text className="text-caption2 text-sub">
                {m.start} - {m.end} ({Number(m.end.slice(0, 2)) - Number(m.start.slice(0, 2))}시간
                {m.best ? ' 연속' : ''} 가능)
              </Text>
            </View>
            {m.best && <Text className="text-caption2 font-semibold text-brand">가장 추천</Text>}
          </Pressable>
        ))}
      </View>
    </Screen>
  );
}

export function RoomSettingsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const qc = useQueryClient();
  const room = useQuery({ queryKey: ['room', id], queryFn: () => api.rooms.get(id) });
  const [code, setCode] = useState(false);
  const [leave, setLeave] = useState(false);
  const out = useMutation({
    mutationFn: () => api.rooms.leave(id),
    onError: () => toast('스터디룸에서 나가지 못했어요. 다시 시도해주세요'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rooms'] });
      setLeave(false);
      router.dismissTo('/(tabs)/studyroom');
      toast('스터디룸에서 나왔어요');
    },
  });
  return (
    <View className="flex-1">
      <Screen>
        <Header title="" />
        <View className="gap-3 rounded-2xl border border-line p-3">
          <View className="flex-row items-center gap-2 rounded-xl bg-cream px-4 py-4">
            <Bell size={ICON.md} color={C.ink} />
            <Text className="flex-1 text-subhead font-semibold text-ink">알림</Text>
            <Text className="text-caption text-sub">알림 설정은 준비 중이에요</Text>
          </View>
          <Pressable
            onPress={() => router.push({ pathname: '/room/invite', params: { id } })}
            className="flex-row items-center gap-2 rounded-xl bg-cream px-4 py-4"
          >
            <UserPlus size={ICON.md} color={C.ink} />
            <Text className="text-subhead font-semibold text-ink">친구 초대</Text>
          </Pressable>
          <Pressable
            onPress={() => setCode(true)}
            className="flex-row items-center gap-2 rounded-xl bg-cream px-4 py-4"
          >
            <View className="flex-row items-center gap-1.5">
              <KeyRound size={ICON.sm} color={C.sub} />
              <Text className="text-subhead font-semibold text-ink">스터디룸 코드</Text>
            </View>
          </Pressable>
          <Pressable
            onPress={() => setLeave(true)}
            className="flex-row items-center gap-2 rounded-xl bg-cream px-4 py-4"
          >
            <Text className="text-subhead font-semibold text-danger">채팅방 나가기</Text>
          </Pressable>
        </View>
      </Screen>
      <Dialog open={code} onClose={() => setCode(false)}>
        <Text className="text-caption text-sub">스터디룸 초대 코드</Text>
        <Text className="mt-1 tabular-nums text-title1 font-bold tracking-[6px] text-ink">
          {room.data?.inviteCode}
        </Text>
        <View className="mt-4 w-full">
          <Two>
            <Btn small kind="outline" onPress={() => setCode(false)}>
              닫기
            </Btn>
            <Btn
              small
              onPress={async () => {
                await Clipboard.setStringAsync(room.data?.inviteCode ?? '');
                setCode(false);
                toast('코드를 복사했어요');
              }}
            >
              복사
            </Btn>
          </Two>
        </View>
      </Dialog>
      <Dialog open={leave} onClose={() => setLeave(false)}>
        <View className="h-10 w-10 items-center justify-center rounded-full bg-mint">
          <Lock size={ICON.sm} color={C.brand} />
        </View>
        <Text className="mt-2 text-subhead font-bold text-ink">{room.data?.title}</Text>
        <Text className="mt-3 text-subhead text-sub">채팅방을 나가시겠어요?</Text>
        <View className="mt-5 w-full">
          <Two>
            <Btn small kind="outline" onPress={() => setLeave(false)}>
              취소
            </Btn>
            <Btn small loading={out.isPending} onPress={() => out.mutate()}>
              확인
            </Btn>
          </Two>
        </View>
      </Dialog>
    </View>
  );
}

export function InviteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const room = useQuery({ queryKey: ['room', id], queryFn: () => api.rooms.get(id) });
  const friends = useQuery({ queryKey: ['friends'], queryFn: api.social.friends });
  const [q, setQ] = useState('');
  const [invited, setInvited] = useState<string[]>([]);
  const inv = useMutation({
    mutationFn: (uid: string) => api.rooms.invite(id, [uid]),
    onError: () => toast('초대하지 못했어요. 다시 시도해주세요'),
    onSuccess: (_, uid) => {
      setInvited((p) => [...p, uid]);
      toast('초대했어요');
    },
  });
  const inRoom = new Set(room.data?.members.map((m) => m.userId));
  const list = (friends.data ?? []).filter((f) => f.nickname.includes(q));
  return (
    <Screen footer={<Btn onPress={() => router.back()}>스터디룸으로 돌아가기</Btn>}>
      <Header title="친구 초대" center />
      <Text className="text-body font-bold text-ink">{room.data?.title}</Text>
      <Text className="text-caption text-sub">함께 공부할 친구를 스터디룸에 초대해 보세요.</Text>
      <View className="mt-3 rounded-2xl bg-mint p-4">
        <Text className="text-caption2 text-sub">스터디룸 초대 코드</Text>
        <View className="flex-row items-center justify-between">
          <Text className="tabular-nums text-title3 font-bold text-ink">
            {room.data?.inviteCode}
          </Text>
          <Pressable
            onPress={async () => {
              await Clipboard.setStringAsync(room.data?.inviteCode ?? '');
              toast('코드를 복사했어요');
            }}
            className="flex-row items-center gap-1 rounded-full bg-brand px-3 py-1"
          >
            <Copy size={ICON.xs} color="#fff" />
            <Text className="text-caption text-white">복사</Text>
          </Pressable>
        </View>
      </View>
      <Text className="mt-1.5 text-caption2 text-sub">
        친구가 초대 코드를 입력하면 이 방에 참여할 수 있어요.
      </Text>
      <View className="mt-4 mb-2 flex-row justify-between">
        <Text className="text-footnote font-bold text-ink">
          내 친구 {friends.data?.length ?? 0}
        </Text>
        <Text className="text-footnote text-sub">{invited.length}명 초대됨</Text>
      </View>
      <Search value={q} onChangeText={setQ} placeholder="친구 이름으로 검색" />
      <View className="mt-2 gap-2">
        {list.map((f) => {
          const st = inRoom.has(f.userId)
            ? '참여 중'
            : invited.includes(f.userId)
              ? '초대됨'
              : '초대하기';
          return (
            <View
              key={f._id}
              className="flex-row items-center gap-3 rounded-xl border border-line px-3 py-2.5"
            >
              <Avatar name={f.nickname} size={30} tone="mint" />
              <View className="flex-1">
                <Text className="text-footnote font-semibold text-ink">{f.nickname}</Text>
                <Text className="text-caption2 text-sub">
                  {inRoom.has(f.userId) ? '이 스터디룸에서 함께 공부 중' : '친구'}
                </Text>
              </View>
              <Pressable
                disabled={st !== '초대하기'}
                onPress={() => inv.mutate(f.userId)}
                className={cx(
                  'rounded-full px-3 py-1',
                  st === '초대하기' ? 'bg-mint' : 'border border-line',
                )}
              >
                <Text
                  className={cx(
                    'text-caption2 font-semibold',
                    st === '초대하기' ? 'text-brand' : 'text-sub',
                  )}
                >
                  {st}
                </Text>
              </Pressable>
            </View>
          );
        })}
      </View>
      <Text className="mt-3 text-center text-caption2 text-sub">
        초대한 친구에게 스터디룸 초대 알림이 전송돼요.
      </Text>
    </Screen>
  );
}
