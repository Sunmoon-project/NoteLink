import { useFeatureNavigation } from '@/lib/feature-navigation';
import { useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { Text, TextInput } from '@/components/text';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CalendarDays,
  Camera,
  CameraOff,
  Layers,
  Lock,
  MessageCircle,
  Mic,
  MicOff,
  NotebookPen,
  Plus,
  Search as SearchIcon,
  Send,
  Settings,
  Siren,
  Smile,
  Timer,
  Users,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react-native';
import type { Message, RoomMember, RoomSharedItem } from '@notelink/shared';
import { api, ApiError } from '@/lib/api';
import { socket } from '@/lib/socket';
import { hms, seoul, ymd } from '@/lib/dates';
import { useNow, useSocket } from '@/hooks';
import { useMockFlags } from '@/lib/mock/flags';
import { toast } from '@/stores/toast';
import {
  Alert,
  Badge,
  Btn,
  Card,
  Chip,
  Dialog,
  Header,
  Input,
  Label,
  Loading,
  Avatar,
  Screen,
  Two,
  cx,
} from '@/components/ui';
import { useAuth } from '@/stores/auth';
import { useNet } from '@/stores/net';
import { C, ICON } from '@/theme';
import { useLiveRoom } from '@/lib/livekit';
import { LoadError } from './tools';

// p.75 스터디룸 입장 · 만들기 / p.76 진입 · 채팅 / p.77 카드 / p.100 연결 끊김

const ACK_TIMEOUT_MS = 8000;

export function RoomListScreen() {
  const mine = useQuery({ queryKey: ['rooms', 'mine'], queryFn: api.rooms.mine });
  const rec = useQuery({ queryKey: ['rooms', 'recommended'], queryFn: api.rooms.recommended });
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [code, setCode] = useState(false);
  const [v, setV] = useState('');
  const join = useMutation({
    mutationFn: (c: string) => api.rooms.join(c),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['rooms'] });
      setCode(false);
      setV('');
      router.push({ pathname: '/room/[id]', params: { id: r._id } });
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : '입장하지 못했어요'),
  });
  const joined = mine.data ?? [];
  return (
    <View className="flex-1 bg-white">
      <Screen>
        <Text className="pt-4 pb-3 text-title2 font-bold text-ink">스터디룸</Text>
        <View className="h-11 flex-row items-center rounded-xl bg-cream px-4">
          <SearchIcon size={ICON.sm} color={C.sub} />
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder="스터디룸 검색"
            placeholderTextColor={C.sub}
            className="ml-2 h-11 flex-1 text-subhead text-ink"
          />
        </View>
        {mine.isPending ? (
          <Loading />
        ) : mine.isError && !mine.data ? (
          <LoadError message="참여 중인 스터디룸을 불러오지 못했어요" retry={mine.refetch} />
        ) : joined.length ? (
          <>
            <Label>참여 중인 스터디룸</Label>
            {joined.map((r) => (
              <Card
                key={r._id}
                tone="mint"
                onPress={() => router.push({ pathname: '/room/[id]', params: { id: r._id } })}
                className="mb-2 flex-row items-center gap-3 p-4"
              >
                <Users size={ICON.lg} color={C.brand} />
                <View className="flex-1">
                  <Text className="text-callout font-bold text-ink">{r.title}</Text>
                  <Text className="text-caption text-sub">
                    {r.memberCount}명 · 코드 {r.inviteCode}
                  </Text>
                </View>
              </Card>
            ))}
            <View className="mt-1 flex-row gap-2">
              <View className="flex-1">
                <Btn small kind="outline" onPress={() => router.push('/(tabs)/studyroom/create')}>
                  스터디룸 만들기
                </Btn>
              </View>
              <View className="flex-1">
                <Btn small kind="outline" onPress={() => setCode(true)}>
                  코드로 참여하기
                </Btn>
              </View>
            </View>
          </>
        ) : (
          <View className="items-center py-10">
            <View className="h-14 w-14 items-center justify-center rounded-full bg-mint">
              <Users size={ICON.xl} color={C.brand} />
            </View>
            <Text className="mt-3 text-callout font-bold text-ink">
              참여 중인 스터디룸이 없어요
            </Text>
            <Text className="text-caption text-sub">친구와 함께 모여 실시간으로 공부해보세요</Text>
            <Btn
              className="mt-5 w-48"
              small
              onPress={() => router.push('/(tabs)/studyroom/create')}
            >
              스터디룸 만들기
            </Btn>
            <Text className="mt-2 text-caption2 text-sub">또는</Text>
            <Pressable
              onPress={() => setCode(true)}
              className="mt-1 rounded-full border border-brand/40 px-4 py-1.5"
            >
              <Text className="text-footnote text-brand">코드로 참여하기</Text>
            </Pressable>
          </View>
        )}
        <Label>
          <Text className="text-footnote font-bold text-ink">추천 스터디룸</Text>
        </Label>
        {rec.isError && !rec.data && (
          <LoadError message="추천 스터디룸을 불러오지 못했어요" retry={rec.refetch} />
        )}
        <View className="gap-2">
          {rec.data
            ?.filter((r) => r.title.includes(q))
            .map((r) => (
              <Card
                key={r._id}
                tone="white"
                onPress={() => join.mutate(r.inviteCode)}
                className="p-4"
              >
                <View className="flex-row items-center justify-between">
                  <Text className="text-subhead font-bold text-ink">{r.title}</Text>
                  <Badge>{`${r.memberCount}명 참여`}</Badge>
                </View>
                <View className="mt-1.5 flex-row gap-1">
                  {r.tags?.map((t) => (
                    <Badge key={t}>{t}</Badge>
                  ))}
                </View>
                <Text className="mt-1.5 text-caption text-sub">{r.description}</Text>
              </Card>
            ))}
        </View>
      </Screen>
      <Dialog open={code} onClose={() => setCode(false)}>
        <View className="h-11 w-11 items-center justify-center rounded-full bg-mint">
          <Lock size={ICON.md} color={C.brand} />
        </View>
        <Text className="mt-2 text-body font-bold text-ink">코드 입력</Text>
        <Text className="text-caption text-sub">코드를 입력해주세요</Text>
        <TextInput
          autoFocus
          value={v}
          onChangeText={(t) =>
            setV(
              t
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, '')
                .slice(0, 6),
            )
          }
          placeholder="예) AB3F9K"
          placeholderTextColor={C.sub}
          autoCapitalize="characters"
          className="mt-4 h-14 w-full rounded-xl border-2 border-brand/30 text-center tabular-nums text-title3 tracking-[6px] text-ink"
        />
        <View className="mt-4 w-full">
          <Two>
            <Btn small kind="outline" onPress={() => setCode(false)}>
              취소
            </Btn>
            <Btn
              small
              disabled={v.length < 6}
              loading={join.isPending}
              onPress={() => join.mutate(v)}
            >
              확인
            </Btn>
          </Two>
        </View>
      </Dialog>
    </View>
  );
}

export function RoomCreateScreen() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [cat, setCat] = useState('코딩');
  const [pub, setPub] = useState(true);
  const create = useMutation({
    mutationFn: () => api.rooms.create({ title: name.trim(), categoryName: cat, isPublic: pub }),
    onError: () => toast('스터디룸을 만들지 못했어요. 다시 시도해주세요'),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['rooms'] });
      router.replace({ pathname: '/room/[id]', params: { id: r._id } });
      toast(`스터디룸을 만들었어요 · 코드 ${r.inviteCode}`);
    },
  });
  return (
    <Screen>
      <Header title="스터디룸 만들기" center />
      <Label>
        <Text className="text-footnote font-bold text-ink">스터디룸 이름</Text>
      </Label>
      <Input value={name} onChangeText={setName} placeholder="예) 파이썬 기초 스터디" autoFocus />
      <Label>
        <Text className="text-footnote font-bold text-ink">카테고리</Text>
      </Label>
      <View className="flex-row gap-2">
        {['코딩', '자격증', '수학', '영어'].map((c) => (
          <Chip key={c} small on={cat === c} onPress={() => setCat(c)}>
            {c}
          </Chip>
        ))}
      </View>
      <Label>
        <Text className="text-footnote font-bold text-ink">공개 여부</Text>
      </Label>
      <View className="flex-row gap-3">
        {(
          [
            [true, '공개', Users],
            [false, '비공개', Lock],
          ] as const
        ).map(([v, l, Ic]) => (
          <Pressable
            key={l}
            onPress={() => setPub(v)}
            className={cx(
              'h-28 flex-1 items-center justify-center rounded-2xl border-2',
              pub === v ? 'border-brand bg-mint' : 'border-transparent bg-cream',
            )}
          >
            <Ic size={ICON.xl} color={C.brand} />
            <Text className="text-footnote font-semibold text-ink">{l}</Text>
          </Pressable>
        ))}
      </View>
      <Btn
        className="mt-8"
        disabled={!name.trim()}
        loading={create.isPending}
        onPress={() => create.mutate()}
      >
        스터디룸 만들기
      </Btn>
    </Screen>
  );
}

export function RoomScreen() {
  const myId = useAuth((s) => s.userId);
  const { id } = useLocalSearchParams<{ id: string }>();
  const timerGeneration = useRef(0);
  const [timer, setTimer] = useState<{ label: string; endsAt: number } | null>(null);
  const room = useQuery({
    queryKey: ['room', id],
    refetchOnMount: 'always',
    queryFn: () => {
      const generation = timerGeneration.current;
      return api.rooms.get(id).then((received) => {
        // 조회를 기다리는 사이 새 소켓 상태를 받았으면 과거 스냅샷은 적용하지 않는다.
        if (generation === timerGeneration.current && received.timerState !== undefined) {
          const current = received.timerState;
          setTimer(
            received.timerRule?.enabled && current?.endsAt
              ? {
                  label:
                    current.phase === 'break'
                      ? '휴식'
                      : current.phase === 'period'
                        ? '교시'
                        : '집중',
                  endsAt: Date.parse(current.endsAt),
                }
              : null,
          );
        }
        return received;
      });
    },
  });
  const chatId = useQuery({ queryKey: ['room-chat', id], queryFn: () => api.rooms.chatRoomId(id) });
  const history = useQuery({
    queryKey: ['messages', chatId.data],
    queryFn: () => api.social.messages(chatId.data!),
    enabled: !!chatId.data,
  });
  const now = useNow();
  const [membersAt, setMembersAt] = useState(() => Date.now());
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const timerEnd = timer?.endsAt;
  const requestedTimerEnd = useRef<number | null>(null);
  const timerRetryAt = useRef(0);
  const refetchRoom = room.refetch;
  useEffect(() => {
    if (timerEnd === undefined || timerEnd > now) return;
    if (requestedTimerEnd.current === timerEnd && now < timerRetryAt.current) return;
    requestedTimerEnd.current = timerEnd;
    timerRetryAt.current = Infinity;
    const retry = () => {
      if (requestedTimerEnd.current === timerEnd) timerRetryAt.current = Date.now() + 5000;
    };
    void refetchRoom().then((result) => {
      if (result.isError) retry();
    }, retry);
  }, [timerEnd, now, refetchRoom]);
  const [menu, setMenu] = useState(false);
  const [pick, setPick] = useState(false);
  const [chat, setChat] = useState(false);
  const [conn, setConn] = useState<'ok' | 'lost' | 'back' | 'kicked'>('ok');
  const [mediaGeneration, setMediaGeneration] = useState(0);
  const day = ymd(seoul(now));
  const midnight = Date.parse(`${day}T00:00:00+09:00`);
  // 입장 시점 값이 아니라 지금까지의 학습 시간을 알린다 (서울 자정에 다시 센다)
  const mySec =
    (ymd(seoul(membersAt)) === day ? (members.find((m) => m.userId === myId)?.todaySec ?? 0) : 0) +
    Math.max(0, Math.floor((now - Math.max(membersAt, midnight)) / 1000));
  const live = useLiveRoom(id, conn !== 'kicked' && !!room.data, mediaGeneration, mySec);
  const [v, setV] = useState('');
  const pending = useRef<{ clientId: string; text: string }[]>([]);
  const messageSeq = useRef(0);
  // 확인 응답이 오지 않은 메시지. 입력을 지운 뒤에도 실패를 알고 다시 보낼 수 있게 한다
  const [failedIds, setFailedIds] = useState<string[]>([]);
  const ackTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = ackTimers.current;
    return () => timers.forEach(clearTimeout);
  }, []);
  const deliver = (chatRoomId: string, clientId: string, text: string) => {
    setFailedIds((ids) => ids.filter((x) => x !== clientId));
    clearTimeout(ackTimers.current.get(clientId));
    ackTimers.current.set(
      clientId,
      setTimeout(() => setFailedIds((ids) => [...ids, clientId]), ACK_TIMEOUT_MS),
    );
    socket.emit('chat:send', { chatRoomId, text, clientId }, (m) => {
      clearTimeout(ackTimers.current.get(clientId));
      ackTimers.current.delete(clientId);
      setFailedIds((ids) => ids.filter((x) => x !== clientId));
      receiveMessage(m, clientId);
    });
  };
  const list = useRef<FlatList<Message>>(null);

  // 방 정보 · 대화 기록을 불러오면 목록을 채운다 (렌더 중 상태 조정)
  const [loadedRoom, setLoadedRoom] = useState<typeof room.data>();
  if (room.data && room.data !== loadedRoom) {
    setLoadedRoom(room.data);
    setMembers(room.data.members);
    setMembersAt(now);
  }
  const [loadedMsgs, setLoadedMsgs] = useState<typeof history.data>();
  if (history.data && history.data !== loadedMsgs) {
    setLoadedMsgs(history.data);
    setMsgs((current) => [
      ...new Map([...history.data!, ...current].map((m) => [m._id, m])).values(),
    ]);
  }
  const receiveMessage = (m: Message, clientId?: string) =>
    setMsgs((messages) => {
      const local = clientId ?? m.clientId;
      const confirmed = local ? messages.filter((x) => x._id !== local) : messages;
      return confirmed.some((x) => x._id === m._id) ? confirmed : [...confirmed, m];
    });
  useEffect(() => {
    socket.emit('room:join', { roomId: id }, (r) => {
      if (!r.ok) toast('채팅에 연결하지 못했어요. 나갔다가 다시 들어와 주세요');
      if (r.missed)
        setMsgs((p) => [...new Map([...p, ...r.missed!].map((m) => [m._id, m])).values()]);
    });
    return () => socket.emit('room:leave', { roomId: id });
  }, [id]);
  useSocket(
    'room:presence',
    (p) => {
      if (p.roomId !== id) return;
      setMembers(p.members);
      setMembersAt(Date.now());
    },
    [id],
  );
  useSocket(
    'room:timer',
    (p) => {
      if (p.roomId !== id) return;
      timerGeneration.current++;
      setTimer(
        p.rule?.enabled && p.endsAt
          ? {
              label: p.phase === 'break' ? '휴식' : p.phase === 'period' ? '교시' : '집중',
              endsAt: new Date(p.endsAt).getTime(),
            }
          : null,
      );
    },
    [id],
  );
  useSocket('chat:message', (m) => m.chatRoomId === chatId.data && receiveMessage(m), [
    chatId.data,
  ]);

  // p.100 연결 끊김 시나리오: 끊김 → (재연결 | 5분 넘으면 자동 퇴장). 목업에서는 설정 > 예외 시나리오로 켠다
  // 실제 소켓이 끊기면 useNet이 'unstable' · 'offline'이 된다. 목업 스위치도 같은 경로로 들어온다
  const disconnect = useMockFlags((s) => s.roomDisconnect);
  const netLost = useNet((s) => s.state === 'unstable' || s.state === 'offline');
  const lost = disconnect || netLost;
  // 끊김 ↔ 복구 전이 (렌더 중 상태 조정)
  if (lost && conn !== 'lost' && conn !== 'kicked') setConn('lost');
  if (!lost && conn === 'lost') setConn('back');
  // 목업: 6초 뒤 다시 연결된 것으로 친다
  useEffect(() => {
    if (!disconnect) return;
    const t = setTimeout(() => useMockFlags.setState({ roomDisconnect: false }), 6000);
    return () => clearTimeout(t);
  }, [disconnect]);
  // 다시 연결되면 끊긴 동안 쓴 메시지를 보내고 잠시 뒤 안내를 닫는다
  useEffect(() => {
    if (conn !== 'back') return;
    socket.emit('room:join', { roomId: id }, (r) => {
      if (!r.ok) toast('채팅에 연결하지 못했어요. 나갔다가 다시 들어와 주세요');
      if (r.missed)
        setMsgs((p) => [...new Map([...p, ...r.missed!].map((m) => [m._id, m])).values()]);
    });
    room.refetch();
    history.refetch();
    const roomId = chatId.data;
    if (roomId) pending.current.forEach(({ clientId, text }) => deliver(roomId, clientId, text));
    pending.current = [];
    const t = setTimeout(() => setConn('ok'), 2600);
    return () => clearTimeout(t);
  }, [conn]); // eslint-disable-line react-hooks/exhaustive-deps

  // HTTP 실패로 끊김 상태가 된 뒤 소켓은 살아 있으면 복구 신호가 없다. 주기적으로 확인한다
  useEffect(() => {
    if (conn !== 'lost' || disconnect) return;
    const t = setInterval(() => void refetchRoom(), 15_000);
    return () => clearInterval(t);
  }, [conn, disconnect, refetchRoom]);

  // 5분 넘게 끊기면 자동 퇴장 (공부 시간 기록은 서버에 저장돼 있다)
  const kick = useMockFlags((s) => s.roomKick);
  if (kick && conn !== 'kicked') setConn('kicked');
  useEffect(() => {
    if (kick) useMockFlags.setState({ roomKick: false });
  }, [kick]);
  useEffect(() => {
    if (conn !== 'lost') return;
    const t = setTimeout(() => setConn('kicked'), 5 * 60 * 1000);
    return () => clearTimeout(t);
  }, [conn]);

  const send = () => {
    if (!v.trim()) return;
    if (!chatId.data) {
      void chatId.refetch();
      return toast('채팅을 준비하고 있어요. 잠시 후 다시 보내 주세요');
    }
    const clientId = `c${Date.now()}-${++messageSeq.current}`;
    const text = v.trim();
    setMsgs((p) => [
      ...p,
      {
        _id: clientId,
        chatRoomId: chatId.data!,
        senderId: myId ?? '',
        type: 'text',
        text,
        sharedItemId: null,
        createdAt: new Date().toISOString(),
      },
    ]);
    if (conn === 'lost') pending.current.push({ clientId, text });
    else deliver(chatId.data, clientId, text);
    setV('');
  };
  if (!room.data && room.isError)
    return (
      <Screen>
        <Header title="스터디룸" />
        <Text className="mt-8 text-center text-body">스터디룸 정보를 불러오지 못했어요</Text>
        <Btn className="mt-4" onPress={() => void room.refetch()}>
          다시 시도
        </Btn>
        <Btn kind="outline" className="mt-2" onPress={() => router.back()}>
          돌아가기
        </Btn>
      </Screen>
    );
  if (!room.data) return <Loading />;
  const last = msgs[msgs.length - 1];
  const tiles = chat ? members.slice(0, 2) : members;
  const remain = timer ? Math.max(0, Math.floor((timer.endsAt - now) / 1000)) : 0;

  return (
    <Screen scroll={false} pad={false}>
      {live.error && (
        <View className="gap-2 p-4">
          <Text>{live.error}</Text>
          {conn !== 'kicked' && (
            <Btn
              onPress={() => {
                if (lost) return toast('연결을 복구한 뒤 다시 시도해 주세요');
                setMediaGeneration((n) => n + 1);
              }}
            >
              미디어 다시 연결
            </Btn>
          )}
        </View>
      )}
      {conn === 'lost' && (
        <View className="bg-sun/25 px-5 py-2">
          <Text className="text-caption font-semibold text-ink">
            ● 연결이 끊겼어요 · 다시 연결 중…
          </Text>
        </View>
      )}
      {conn === 'back' && (
        <View className="mx-4 mt-2 rounded-xl bg-ink px-4 py-2.5">
          <Text className="text-caption font-bold text-white">다시 연결됐어요</Text>
          <Text className="text-caption text-white/60">
            멤버와 대화 기록을 다시 확인하고 있어요
          </Text>
        </View>
      )}
      {!chat && (
        <View className="px-5">
          <View className="h-11 flex-row items-center justify-between">
            <Pressable accessibilityLabel="나가기" onPress={() => router.back()} hitSlop={10}>
              <ArrowLeft size={ICON.lg} color={C.ink} />
            </Pressable>
            <Pressable
              accessibilityLabel="세부 설정"
              onPress={() => router.push({ pathname: '/room/settings', params: { id } })}
              hitSlop={10}
            >
              <Settings size={ICON.md} color={C.ink} />
            </Pressable>
          </View>
          <View className="flex-row items-center justify-between">
            <Text className="text-title3 font-bold text-ink">{room.data.title}</Text>
            <View className="flex-row gap-1">
              {timer && (
                <Badge tone="dark">{`${timer.label} ${remain >= 3600 ? hms(remain) : hms(remain).slice(3)}`}</Badge>
              )}
              <Badge tone="gray">{`${members.length}명 접속중`}</Badge>
            </View>
          </View>
        </View>
      )}
      <View className="flex-row flex-wrap justify-between gap-y-2.5 px-4 pt-3">
        {tiles.map((m) => {
          const me = m.userId === myId;
          const camOn = me ? live.camOn : m.camOn;
          return (
            <View
              key={m.userId}
              className={cx(
                'w-[48.5%] items-center justify-center rounded-2xl',
                chat ? 'h-20' : 'h-[118px]',
                camOn ? 'bg-night' : 'bg-mint',
              )}
            >
              {live.video(m.userId)}
              {camOn && (
                <View className="absolute top-2.5 right-2.5 h-1.5 w-1.5 rounded-full bg-sun" />
              )}
              {!camOn && <Avatar uri={m.avatarUrl} name={m.nickname} size={chat ? 28 : 44} />}
              <Text className={cx('text-footnote font-bold', camOn ? 'text-white' : 'text-ink')}>
                {m.nickname}
              </Text>
              <Text
                className={cx('tabular-nums text-caption', camOn ? 'text-white/70' : 'text-ink/60')}
              >
                {conn === 'lost' && !me
                  ? '연결 확인 중'
                  : hms(
                      me
                        ? mySec
                        : (ymd(seoul(membersAt)) === day ? (m.todaySec ?? 0) : 0) +
                            (conn === 'lost'
                              ? 0
                              : Math.max(
                                  0,
                                  Math.floor((now - Math.max(membersAt, midnight)) / 1000),
                                )),
                    )}
              </Text>
              {!chat && !(me ? live.micOn : m.micOn) && (
                <View className="absolute bottom-2.5 left-2.5">
                  <MicOff size={ICON.xs} color={camOn ? 'rgba(255,255,255,.5)' : C.sub} />
                </View>
              )}
            </View>
          );
        })}
      </View>

      {chat ? (
        <FlatList
          ref={list}
          data={msgs}
          keyExtractor={(m) => m._id}
          onContentSizeChange={() => list.current?.scrollToEnd()}
          className="mt-2 flex-1 bg-cream"
          contentContainerClassName="gap-3 px-4 py-3"
          renderItem={({ item: m }) => {
            const mine = m.senderId === myId;
            return (
              <View className={cx(mine && 'items-end')}>
                {!mine && (
                  <View className="flex-row items-center gap-1.5 mb-1">
                    <MessageCircle size={ICON.xs} color={C.sub} />
                    <Text className="text-caption2 text-sub">{m.senderNickname ?? '멤버'}</Text>
                  </View>
                )}
                <View className="max-w-[78%] rounded-2xl bg-white px-3 py-2">
                  <Text className="text-footnote text-ink">{m.text ?? '공유 자료를 보냈어요'}</Text>
                </View>
                {failedIds.includes(m._id) && (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => deliver(m.chatRoomId, m._id, m.text ?? '')}
                  >
                    <Text className="mt-1 text-caption2 text-danger">
                      전송하지 못했어요 · 다시 보내기
                    </Text>
                  </Pressable>
                )}
                {mine && conn === 'back' && m === msgs[msgs.length - 1] && (
                  <Text className="mt-1 text-caption2 text-brand">자동으로 전송했어요</Text>
                )}
              </View>
            );
          }}
        />
      ) : (
        <View className="mt-auto px-4 pb-1">
          <View className="flex-row gap-2">
            <Ctl
              on={live.micOn}
              onPress={live.toggleMic}
              icon={
                live.micOn ? (
                  <Mic size={ICON.sm} color={C.ink} />
                ) : (
                  <MicOff size={ICON.sm} color={C.sub} />
                )
              }
              label={`내 마이크 ${live.micOn ? '켜짐' : '꺼짐'}`}
            />
            <Ctl
              on={live.camOn}
              onPress={live.toggleCam}
              icon={
                live.camOn ? (
                  <Camera size={ICON.sm} color={C.ink} />
                ) : (
                  <CameraOff size={ICON.sm} color={C.sub} />
                )
              }
              label={`내 카메라 ${live.camOn ? '켜짐' : '꺼짐'}`}
            />
            <Ctl
              on={live.hearing}
              onPress={live.toggleHearing}
              icon={
                live.hearing ? (
                  <Volume2 size={ICON.sm} color={C.ink} />
                ) : (
                  <VolumeX size={ICON.sm} color={C.sub} />
                )
              }
              label={`듣기 ${live.hearing ? '켜짐' : '꺼짐'}`}
              sub="내 학습하는 소리만"
              strong
            />
          </View>
          <View className="mt-2 flex-row items-center rounded-2xl border border-line px-3 py-2.5">
            <Pressable onPress={() => setChat(true)} className="flex-1">
              <Text numberOfLines={1} className="text-caption text-sub">
                💬{' '}
                {last
                  ? `${last.senderId === myId ? '나' : (last.senderNickname ?? '멤버')}: ${last.text ?? '공유 자료'}`
                  : '채팅을 시작해 보세요'}
              </Text>
            </Pressable>
            <Pressable
              accessibilityLabel="도구"
              onPress={() => setMenu((m) => !m)}
              className={cx(
                'h-8 w-8 items-center justify-center rounded-full',
                menu ? 'bg-ink' : 'bg-mint',
              )}
            >
              {menu ? <X size={ICON.sm} color="#fff" /> : <Plus size={ICON.sm} color={C.brand} />}
            </Pressable>
          </View>
        </View>
      )}
      <View className="flex-row items-center gap-2 px-4 pt-2 pb-3">
        <View className="flex-1 flex-row items-center gap-2 rounded-full bg-cream px-3">
          <View className="h-6 w-6 items-center justify-center rounded-full bg-ink">
            <Plus size={ICON.xs} color="#fff" />
          </View>
          <TextInput
            value={v}
            onFocus={() => setChat(true)}
            onChangeText={setV}
            onSubmitEditing={send}
            returnKeyType="send"
            placeholder="채팅을 입력하는 중입"
            placeholderTextColor={C.sub}
            className="h-11 flex-1 text-footnote text-ink"
          />
          <Smile size={ICON.md} color={C.sun} />
        </View>
        <Pressable
          accessibilityLabel="전송"
          onPress={send}
          className="h-9 w-9 items-center justify-center rounded-lg bg-ink"
        >
          <Send size={ICON.sm} color="#fff" />
        </Pressable>
      </View>
      {chat && (
        <Pressable
          onPress={() => setChat(false)}
          className="absolute top-2 right-3 rounded-full bg-black/40 px-2 py-0.5"
        >
          <Text className="text-caption2 text-white">캠 보기</Text>
        </Pressable>
      )}

      {menu && (
        <View className="absolute right-5 bottom-[150px] z-20 gap-1 rounded-2xl border border-line bg-white p-1.5 shadow-lg">
          {(
            [
              [
                CalendarDays,
                '시간표',
                () => router.push({ pathname: '/room/schedule', params: { id } }),
              ],
              [Siren, '신고', () => router.push({ pathname: '/room/report', params: { id } })],
              [Timer, '타이머', () => router.push({ pathname: '/room/timer', params: { id } })],
              [Layers, '퀴즈', () => setPick(true)],
            ] as const
          ).map(([Ic, l, fn]) => (
            <Pressable
              key={l}
              onPress={() => {
                setMenu(false);
                fn();
              }}
              className="items-center rounded-xl px-3 py-1.5 active:bg-cream"
            >
              <Ic size={ICON.md} color={C.brand} />
              <Text className="text-caption2 text-ink">{l}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <Dialog open={pick} onClose={() => setPick(false)}>
        <Text className="mb-4 text-callout font-bold text-ink">학습 자료 유형 선택</Text>
        <View className="w-full flex-row gap-2">
          <Pressable
            onPress={() => {
              setPick(false);
              router.push({ pathname: '/room/cards', params: { id } });
            }}
            className="h-20 flex-1 items-center justify-center rounded-2xl bg-mint"
          >
            <View className="flex-row items-center gap-1.5">
              <NotebookPen size={ICON.sm} color={C.sub} />
              <Text className="text-subhead font-semibold text-ink">퀴즈</Text>
            </View>
          </Pressable>
          <Pressable
            onPress={() => {
              setPick(false);
              router.push({ pathname: '/room/cards', params: { id } });
            }}
            className="h-20 flex-1 items-center justify-center rounded-2xl bg-mint"
          >
            <Text className="text-subhead font-semibold text-ink">🃏 플래시 카드</Text>
          </Pressable>
        </View>
      </Dialog>
      <Alert
        open={conn === 'kicked'}
        title="스터디룸에서 나갔어요"
        body={`5분 넘게 연결되지 않아 자동으로 퇴장했어요.\n공부 시간 기록은 저장돼 있어요.`}
        secondary="홈으로"
        onSecondary={() => router.dismissTo('/')}
        primary="다시 입장"
        onPrimary={() => {
          if (lost) return toast('연결을 복구한 뒤 다시 입장해 주세요');
          setMediaGeneration((n) => n + 1);
          setConn('back');
        }}
      />
    </Screen>
  );
}

const Ctl = ({
  on,
  onPress,
  icon,
  label,
  sub,
  strong,
}: {
  on: boolean;
  onPress: () => void;
  icon: React.ReactNode;
  label: string;
  sub?: string;
  strong?: boolean;
}) => (
  <Pressable
    onPress={onPress}
    accessibilityState={{ selected: on }}
    className={cx(
      'h-14 flex-1 items-center justify-center rounded-xl',
      strong && on ? 'border border-brand/30 bg-mint' : 'bg-cream',
    )}
  >
    {icon}
    <Text className={cx('mt-0.5 text-caption2 font-semibold', on ? 'text-ink' : 'text-sub')}>
      {label}
    </Text>
    {sub && <Text className="text-caption2 text-sub">{sub}</Text>}
  </Pressable>
);

export function RoomCardsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const openFeature = useFeatureNavigation();
  const shared = useQuery({ queryKey: ['room-shared', id], queryFn: () => api.rooms.shared(id) });
  const others = shared.data?.items.filter((i) => i.itemType !== 'flashcards') ?? [];
  const openItem = (item: RoomSharedItem) => {
    if (item.itemType === 'quiz' && item.quizSetId)
      openFeature({ pathname: '/play/solve', params: { setId: item.quizSetId, from: 'room' } });
    else if (item.itemType === 'material' && item.materialId)
      openFeature({ pathname: '/(tabs)/note/doc/[id]', params: { id: item.materialId } });
  };
  const [flip, setFlip] = useState<string[]>([]);
  const owner = shared.data?.items.find((i) => i.itemType === 'flashcards')?.sharedByNickname;
  return (
    <Screen>
      <Pressable
        onPress={() => router.back()}
        className="mt-3 flex-row items-center gap-2 self-start rounded-full border border-line px-3 py-1.5"
      >
        <ArrowLeft size={ICON.sm} color={C.ink} />
        <Text className="text-footnote text-ink">뒤로 가기</Text>
      </Pressable>
      {shared.isError && (
        <LoadError message="공유 자료를 불러오지 못했어요" retry={shared.refetch} />
      )}
      {shared.isSuccess && others.length === 0 && shared.data.flashcards.length === 0 && (
        <Text className="py-12 text-center text-footnote text-sub">아직 공유된 자료가 없어요</Text>
      )}
      {others.map((item) => (
        <Pressable
          key={item._id}
          accessibilityRole="button"
          onPress={() => openItem(item)}
          className="mt-3 flex-row items-center justify-between rounded-xl border border-line px-4 py-3"
        >
          <Text className="flex-1 text-footnote font-semibold text-ink">{item.title}</Text>
          <Text className="text-caption2 text-sub">
            {item.sharedByNickname} · {item.itemType === 'quiz' ? '퀴즈' : '자료'}
          </Text>
        </Pressable>
      ))}
      <Text className="mt-3 text-caption text-sub">
        {owner ? `${owner}님이 공유한 플래시 카드` : '공유된 플래시 카드'} · 탭해서 뒤집기
      </Text>
      <View className="mt-3 flex-row flex-wrap justify-between gap-y-3">
        {shared.data?.flashcards.map((c) => {
          const on = flip.includes(c._id);
          return (
            <Pressable
              key={c._id}
              onPress={() => setFlip((p) => (on ? p.filter((x) => x !== c._id) : [...p, c._id]))}
              className={cx(
                'h-36 w-[48.5%] items-center justify-center rounded-2xl border p-3',
                on ? 'border-brand bg-brand' : 'border-line bg-mint',
              )}
            >
              <Text
                className={cx(
                  'text-center text-footnote font-semibold',
                  on ? 'text-white' : 'text-ink',
                )}
              >
                {on ? c.back : c.front}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </Screen>
  );
}
