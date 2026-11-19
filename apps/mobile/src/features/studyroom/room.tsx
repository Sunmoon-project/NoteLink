import Animated, { FadeIn, FadeInDown, FadeOut, FadeOutDown } from 'react-native-reanimated';
import { useFeatureNavigation } from '@/lib/feature-navigation';
import {
  addChatOutbox,
  readChatOutbox,
  removeChatOutbox,
  type QueuedChatMessage,
} from '@/lib/chat-outbox';
import { loadCompleteChatHistory } from '@/lib/chat-history';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  Keyboard,
  Platform,
  ScrollView,
  View,
  useWindowDimensions,
  type KeyboardEvent,
} from 'react-native';
import { Pressable } from '@/components/press';
import { Text, TextInput } from '@/components/text';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CalendarDays,
  Camera,
  CameraOff,
  FileText,
  ImageIcon,
  Layers,
  Lock,
  MessageCircle,
  Mic,
  MicOff,
  NotebookPen,
  Plus,
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
import type { Message, RoomMember, RoomSharedItem, StudyRoom } from '@notelink/shared';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import * as WebBrowser from 'expo-web-browser';
import { Image } from 'react-native';
import { UploadError, uploadToBlob, type LocalFile } from '@/lib/upload';
import { api, ApiError } from '@/lib/api';
import { socket } from '@/lib/socket';
import { hms, seoul, ymd } from '@/lib/dates';
import { useNow, useSocket, useTabRefresh } from '@/hooks';
import { toast } from '@/stores/toast';
import {
  Alert,
  Avatar,
  Badge,
  Btn,
  Canvas,
  Card,
  Dialog,
  Header,
  Input,
  LIST_LAYOUT,
  Label,
  Loading,
  Screen,
  Search,
  SwipeAction,
  Title,
  Two,
  cx,
  Pop,
  POP_IN,
} from '@/components/ui';
import { useAuth } from '@/stores/auth';
import { useNet } from '@/stores/net';
import { C, ICON, MOTION } from '@/theme';
import { useLiveRoom } from '@/lib/livekit';
import { LoadError } from './tools';
import { InterestPicker } from '@/features/profile/interest-picker';
import { learnerTypeLabel } from '@/lib/learner-type';
import { useRoomOrientation } from './room-orientation';

// p.75 스터디룸 입장 · 만들기 / p.76 진입 · 채팅 / p.77 카드 / p.100 연결 끊김

const ACK_TIMEOUT_MS = 8000;

// 채팅 열기 · 캠 보기 전환. 바뀌는 쪽만 짧게(들어오기 MOTION.enter · 나가기 MOTION.exit) 투명도 · 세로 이동으로 움직인다.
// 레이아웃 애니메이션은 UI 스레드에서 돌고, 기기의 「동작 줄이기」가 켜져 있으면 움직이지 않는다(ReduceMotion.System 기본값)
const SWAP_IN = FadeIn.duration(MOTION.enter);
const SWAP_OUT = FadeOut.duration(MOTION.exit);
const RISE_IN = FadeInDown.duration(MOTION.enter);
const SINK_OUT = FadeOutDown.duration(MOTION.exit);

export function RoomListScreen() {
  const mine = useQuery({ queryKey: ['rooms', 'mine'], queryFn: api.rooms.mine });
  const rec = useQuery({ queryKey: ['rooms', 'recommended'], queryFn: api.rooms.recommended });
  // 방 안(소켓으로 실시간)은 대상이 아니다. 목록만 돌아올 때 · 당길 때 다시 읽는다
  const refresh = useTabRefresh(mine, rec);
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
  // 목록에서 왼쪽으로 밀어 나가기(방 설정의 「채팅방 나가기」와 같은 동작 · 확인을 거친다)
  const [leaving, setLeaving] = useState<{
    _id: string;
    title: string;
    memberCount: number;
  } | null>(null);
  const leave = useMutation({
    mutationFn: (roomId: string) => api.rooms.leave(roomId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rooms'] });
      toast('스터디룸에서 나왔어요');
    },
    onError: () => toast('스터디룸에서 나가지 못했어요. 다시 시도해주세요'),
  });
  const joined = mine.data ?? [];
  const recList = (rec.data ?? []).filter(
    (r) => r.title.includes(q) && !joined.some((j) => j._id === r._id),
  );
  return (
    <Canvas>
      <Screen refresh={refresh}>
        <Title>스터디룸</Title>
        <Search value={q} onChangeText={setQ} placeholder="스터디룸 검색" />
        {mine.isPending ? (
          <Loading />
        ) : mine.isError && !mine.data ? (
          <LoadError message="참여 중인 스터디룸을 불러오지 못했어요" retry={mine.refetch} />
        ) : joined.length ? (
          <>
            <Label>참여 중인 스터디룸</Label>
            {joined.map((r) => (
              <Animated.View
                key={r._id}
                layout={LIST_LAYOUT}
                entering={FadeIn.duration(MOTION.enter)}
                exiting={FadeOut.duration(MOTION.exit)}
                className="mb-4 overflow-hidden rounded-card"
              >
                <SwipeAction label="나가기" name={r.title} onAction={() => setLeaving(r)}>
                  <Card
                    key={r._id}
                    onPress={() => router.push({ pathname: '/room/[id]', params: { id: r._id } })}
                    className="flex-row items-center gap-3 p-6"
                  >
                    <View className="flex-1">
                      <View className="flex-row items-center gap-2">
                        <Text className="text-callout font-bold text-ink">{r.title}</Text>
                        {r.timerState?.phase === 'focus' && <Badge tone="sun">집중 중</Badge>}
                      </View>
                      <Text className="text-caption text-sub">
                        {r.memberCount}명 · 코드 {r.inviteCode}
                      </Text>
                      <RoomLabels room={r} className="mt-2" />
                    </View>
                    <Faces members={r.members} />
                  </Card>
                </SwipeAction>
              </Animated.View>
            ))}
            <View className="mt-2 flex-row gap-2.5">
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
            <View className="h-20 w-20 items-center justify-center rounded-full bg-cream">
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
              className="mt-1 rounded-full bg-white px-4 py-2"
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
        {rec.isSuccess && !recList.length && (
          <Text className="py-6 text-center text-footnote text-sub">
            {q ? `‘${q}’에 맞는 스터디룸이 없어요` : '지금 추천할 스터디룸이 없어요'}
          </Text>
        )}
        <View className="gap-4">
          {recList.map((r) => (
            <Animated.View
              key={r._id}
              layout={LIST_LAYOUT}
              entering={FadeIn.duration(MOTION.enter)}
              exiting={FadeOut.duration(MOTION.exit)}
            >
              <Card key={r._id} onPress={() => join.mutate(r.inviteCode)} className="p-6">
                <View className="flex-row items-center justify-between">
                  <Text className="text-subhead font-bold text-ink">{r.title}</Text>
                  <Badge>{`${r.memberCount}명 참여`}</Badge>
                </View>
                <RoomLabels room={r} className="mt-2.5" />
                {!!r.description && (
                  <Text className="mt-2.5 text-caption text-sub">{r.description}</Text>
                )}
              </Card>
            </Animated.View>
          ))}
        </View>
      </Screen>
      <Alert
        open={!!leaving}
        title="스터디룸에서 나갈까요?"
        body={
          leaving?.memberCount === 1
            ? `${leaving.title}의 마지막 멤버예요. 나가면 방이 닫히고 7일 후 방과 채팅 기록이 삭제돼요.`
            : `${leaving?.title ?? '이 방'}에서 나가요. 코드로 다시 들어올 수 있어요.`
        }
        secondary="취소"
        onSecondary={() => setLeaving(null)}
        primary="나가기"
        onPrimary={() => {
          if (leaving) leave.mutate(leaving._id);
          setLeaving(null);
        }}
      />
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
    </Canvas>
  );
}

/**
 * 방 카드의 카테고리 칩 + 대상 배지. 이름은 categoryNames만 쓴다(서버가 지워진 분야 이름을 빼므로
 * categoryIds와 순서로 짝짓지 않는다). 예전 응답은 categoryName 하나, 대상이 없으면 배지를 숨긴다
 */
function RoomLabels({ room, className }: { room: StudyRoom; className?: string }) {
  const names = room.categoryNames ?? (room.categoryName ? [room.categoryName] : []);
  const target = learnerTypeLabel(room.learnerType);
  if (!names.length && !target) return null;
  return (
    <View className={cx('flex-row flex-wrap gap-1', className)}>
      {names.map((name) => (
        <Badge key={name}>{name}</Badge>
      ))}
      {target && <Badge tone="gray">{target}</Badge>}
    </View>
  );
}

/** 참여 중인 방의 참여자 얼굴을 겹쳐 보인다 (3명까지, 나머지는 +n) */
function Faces({ members }: { members: RoomMember[] }) {
  const on = members.filter((m) => m.status === 'joined');
  if (!on.length) return null;
  return (
    <View className="flex-row items-center">
      {on.slice(0, 3).map((m, i) => (
        <View key={m.userId} className={cx('rounded-full border-2 border-white', i > 0 && '-ml-2')}>
          <Avatar name={m.nickname} uri={m.avatarUrl} size={28} />
        </View>
      ))}
      {on.length > 3 && <Text className="ml-1 text-caption text-sub">+{on.length - 3}</Text>}
    </View>
  );
}

/** 딥링크 · 알림으로 바로 들어오면 뒤로 갈 화면이 없다 — 그때는 스터디룸 탭으로 */
const leaveRoom = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/studyroom'));

const MAX_ROOM_CATEGORIES = 3;

export function RoomCreateScreen() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  // 관심 분야와 같은 목록 · 선택기에서 최대 3개, 먼저 고른 것이 대표
  const categories = useQuery({
    queryKey: ['interest-categories'],
    queryFn: api.me.interestCategories,
  });
  const [cats, setCats] = useState<string[]>([]);
  const toggle = (id: string) =>
    setCats((cur) => {
      if (cur.includes(id)) return cur.filter((c) => c !== id);
      if (cur.length >= MAX_ROOM_CATEGORIES) {
        toast(`카테고리는 ${MAX_ROOM_CATEGORIES}개까지 고를 수 있어요`);
        return cur;
      }
      return [...cur, id];
    });
  const [pub, setPub] = useState(true);
  const create = useMutation({
    mutationFn: () => api.rooms.create({ title: name.trim(), categoryIds: cats, isPublic: pub }),
    onError: () => toast('스터디룸을 만들지 못했어요. 다시 시도해주세요'),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['rooms'] });
      // 만들기 화면은 스터디룸 탭 안, 방은 바깥 스택이다. replace하면 탭까지 바뀌어 나갈 곳이 없어진다
      router.back();
      router.push({ pathname: '/room/[id]', params: { id: r._id } });
      toast(`스터디룸을 만들었어요 · 코드 ${r.inviteCode}`);
    },
  });
  return (
    <Canvas>
      <Screen>
        <Header title="스터디룸 만들기" center />
        <Label>
          <Text className="text-footnote font-bold text-ink">스터디룸 이름</Text>
        </Label>
        <Input value={name} onChangeText={setName} placeholder="예) 파이썬 기초 스터디" autoFocus />
        <Label>
          <Text className="text-footnote font-bold text-ink">
            카테고리 <Text className="text-caption text-sub">최대 {MAX_ROOM_CATEGORIES}개</Text>
          </Text>
        </Label>
        {categories.isPending ? (
          <Loading />
        ) : categories.isError ? (
          <LoadError message="카테고리를 불러오지 못했어요" retry={categories.refetch} />
        ) : (
          <InterestPicker categories={categories.data} selected={cats} onToggle={toggle} />
        )}
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
                pub === v ? 'border-brand bg-mint' : 'border-transparent bg-white',
              )}
            >
              <Ic size={ICON.xl} color={C.brand} />
              <Text className="text-footnote font-semibold text-ink">{l}</Text>
            </Pressable>
          ))}
        </View>
        <Btn
          className="mt-8"
          disabled={!name.trim() || !cats.length}
          loading={create.isPending}
          onPress={() => create.mutate()}
        >
          스터디룸 만들기
        </Btn>
      </Screen>
    </Canvas>
  );
}

/** 채팅 입력줄 이모지 고르기 칸에 보이는 이모지(공부하며 자주 쓰는 것) */
export const CHAT_EMOJIS = [
  '😀',
  '😂',
  '😭',
  '🥲',
  '🤔',
  '👍',
  '👏',
  '🙏',
  '💪',
  '🔥',
  '✅',
  '📚',
  '✍️',
  '☕',
  '🎉',
  '❤️',
];

/** 화면 아래끝(창 기준)과 키보드 위끝이 겹치는 높이. 겹치지 않으면 0 */
export const keyboardOverlap = (frame: { y: number; height: number }, keyboardTop: number) =>
  Math.max(0, Math.round(frame.y + frame.height - keyboardTop));

/**
 * 키보드가 이 화면을 가리는 높이. 공용 KeyboardAvoidingView는 부모 기준 위치로 계산해 실기기에서 입력줄이
 * 덜 올라가 채팅을 치는 내용이 키보드에 가렸다. 창 기준(measureInWindow)으로 재서 그만큼 올린다
 */
export function useKeyboardInset(ref: React.RefObject<View | null>) {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const ios = Platform.OS === 'ios';
    const show = (e: KeyboardEvent) => {
      const top = e.endCoordinates.screenY;
      const node = ref.current;
      if (!node) return;
      node.measureInWindow((_x, y, _w, height) => setInset(keyboardOverlap({ y, height }, top)));
    };
    const subs = [
      Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', show),
      Keyboard.addListener(ios ? 'keyboardWillChangeFrame' : 'keyboardDidShow', show),
      Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () => setInset(0)),
    ];
    return () => subs.forEach((sub) => sub.remove());
  }, [ref]);
  return inset;
}

export function RoomScreen() {
  useRoomOrientation();
  const openFeature = useFeatureNavigation();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const columns = landscape ? 3 : 2;
  const tileGap = landscape ? 8 : 10;
  const tileWidth = Math.max(
    0,
    (width - insets.left - insets.right - 32 - tileGap * (columns - 1)) / columns,
  );
  const tileHeight = landscape ? (height < 380 ? 100 : 140) : 118;
  const myId = useAuth((s) => s.userId);
  const { id } = useLocalSearchParams<{ id: string }>();
  const openSharedMessage = async (itemId: string) => {
    try {
      const item = await api.rooms.sharedItem(id, itemId);
      if (item.itemType !== 'material') {
        router.push({ pathname: '/room/shared', params: { id, itemId } });
        return;
      }
      const pathname =
        item.kind === 'handwriting'
          ? '/(tabs)/note/hand/[id]'
          : item.kind === 'recording'
            ? '/(tabs)/note/rec/[id]'
            : '/(tabs)/note/doc/[id]';
      openFeature({ pathname, params: { id: item.materialId } });
    } catch {
      toast('이 자료를 열 수 없어요');
    }
  };
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
  const [joinedRoom, setJoinedRoom] = useState<string | null>(null);
  const syncEpoch = useRef(0);
  const history = useQuery({
    queryKey: ['messages', chatId.data],
    queryFn: () => {
      const epoch = syncEpoch.current;
      return loadCompleteChatHistory(
        (before) => api.social.messages(chatId.data!, before),
        () =>
          syncEpoch.current === epoch && !['offline', 'unstable'].includes(useNet.getState().state),
      );
    },
    enabled: !!chatId.data && joinedRoom === id,
  });
  const now = useNow();
  const [membersAt, setMembersAt] = useState(() => Date.now());
  const [members, setMembers] = useState<RoomMember[]>([]);
  const membersAtRef = useRef(membersAt);
  useEffect(() => {
    membersAtRef.current = membersAt;
  }, [membersAt]);
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
  // 채팅 입력줄의 이모지 고르기 칸 · + 로 여는 첨부(사진 · 파일) 고르기
  const [emoji, setEmoji] = useState(false);
  const [attach, setAttach] = useState(false);
  // 보내는 중인 첨부: 다시 보낼 때 고른 파일 · 이미 올린 주소를 다시 쓴다
  const attachments = useRef(
    new Map<string, { kind: 'image' | 'file'; file: LocalFile; blobUrl?: string }>(),
  );
  const keyboardFrame = useRef<View>(null);
  const keyboardInset = useKeyboardInset(keyboardFrame);
  // 방을 떠나면(설정 · 카드 · 초대 등 다른 화면으로) 채팅을 닫고 키보드를 내린다. 돌아왔을 때 채팅 화면이 아니라
  // 캠 화면이 보이게: 채팅을 연 채로 다녀오면 뒤로 가기를 눌러도 계속 채팅 화면으로 돌아오는 것처럼 보였다
  useFocusEffect(
    useCallback(
      () => () => {
        setChat(false);
        Keyboard.dismiss();
      },
      [],
    ),
  );
  // 채팅 중의 뒤로 가기는 채팅을 닫고 캠 화면으로, 캠 화면에서는 방을 나간다
  const back = () => {
    if (!chat) return leaveRoom();
    setChat(false);
    Keyboard.dismiss();
  };
  const [conn, setConn] = useState<'ok' | 'lost' | 'back' | 'kicked'>('ok');
  const [socketConnected, setSocketConnected] = useState<boolean | null>(null);
  const [chatJoinFailed, setChatJoinFailed] = useState(false);
  const [mediaGeneration, setMediaGeneration] = useState(0);
  const day = ymd(seoul(now));
  const midnight = Date.parse(`${day}T00:00:00+09:00`);
  // 입장 시점 값이 아니라 지금까지의 학습 시간을 알린다 (서울 자정에 다시 센다)
  const mySec =
    (ymd(seoul(membersAt)) === day ? (members.find((m) => m.userId === myId)?.todaySec ?? 0) : 0) +
    Math.max(0, Math.floor((now - Math.max(membersAt, midnight)) / 1000));
  const live = useLiveRoom(id, conn !== 'kicked' && !!room.data, mediaGeneration, mySec);
  const [v, setV] = useState('');
  const pending = useRef<QueuedChatMessage[]>([]);
  const joinedChat = useRef(false);
  const inFlight = useRef(new Set<string>());
  const messageSeq = useRef(0);
  // 확인 응답이 오지 않은 메시지. 입력을 지운 뒤에도 실패를 알고 다시 보낼 수 있게 한다
  const [failedIds, setFailedIds] = useState<string[]>([]);
  const ackTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = ackTimers.current;
    return () => timers.forEach(clearTimeout);
  }, []);
  // 이 화면에서 새로 보내거나 받은 메시지(말풍선이 떠오르며 나타난다). 불러온 이전 기록 · 서버가 확인해 바뀐 내 메시지는 넣지 않는다
  const fresh = useRef(new Set<string>());
  const receiveMessage = (m: Message, clientId?: string) =>
    setMsgs((messages) => {
      const local = clientId ?? (m.senderId === myId ? m.clientId : undefined);
      if (!local && !messages.some((x) => x._id === m._id)) fresh.current.add(m._id);
      const confirmed = local ? messages.filter((x) => x._id !== local) : messages;
      return confirmed.some((x) => x._id === m._id) ? confirmed : [...confirmed, m];
    });
  const deliver = (chatRoomId: string, clientId: string, text: string) => {
    if (inFlight.current.has(clientId)) return;
    inFlight.current.add(clientId);
    setFailedIds((ids) => ids.filter((x) => x !== clientId));
    clearTimeout(ackTimers.current.get(clientId));
    ackTimers.current.set(
      clientId,
      setTimeout(() => {
        inFlight.current.delete(clientId);
        setFailedIds((ids) => [...new Set([...ids, clientId])]);
      }, ACK_TIMEOUT_MS),
    );
    socket.emit('chat:send', { chatRoomId, text, clientId }, (m) => {
      clearTimeout(ackTimers.current.get(clientId));
      ackTimers.current.delete(clientId);
      inFlight.current.delete(clientId);
      if (myId && m.senderId === myId && m.clientId === clientId) {
        try {
          removeChatOutbox(myId, id, clientId);
          pending.current = pending.current.filter((entry) => entry.clientId !== clientId);
        } catch {
          toast('전송 확인을 기기에 저장하지 못했어요');
        }
      }
      setFailedIds((ids) => ids.filter((x) => x !== clientId));
      receiveMessage(m, clientId);
    });
  };
  const flushPending = () => {
    if (!joinedChat.current || useAuth.getState().userId !== myId) return;
    pending.current.forEach((entry) => deliver(entry.chatRoomId, entry.clientId, entry.text));
  };
  useEffect(() => {
    if (!myId || !id || !chatId.data) return;
    try {
      const restored = readChatOutbox(myId, id).filter((entry) => entry.chatRoomId === chatId.data);
      pending.current = restored;
      // 디스크에 보관한 대기열을 화면 상태에 복원한다.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMsgs((current) => {
        const known = new Set(current.map((m) => m._id));
        const queued = restored
          .filter((entry) => !known.has(entry.clientId))
          .map((entry) => ({
            _id: entry.clientId,
            clientId: entry.clientId,
            chatRoomId: entry.chatRoomId,
            senderId: myId,
            type: 'text' as const,
            text: entry.text,
            sharedItemId: null,
            createdAt: entry.createdAt,
          }));
        return [...current, ...queued];
      });
      flushPending();
    } catch {
      toast('전송 대기 메시지를 불러오지 못했어요');
    }
  }, [myId, id, chatId.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = useRef<FlatList<Message>>(null);

  // 방 정보 · 대화 기록을 불러오면 목록을 채운다 (렌더 중 상태 조정)
  const [loadedRoom, setLoadedRoom] = useState<typeof room.data>();
  if (room.data && room.data !== loadedRoom) {
    setLoadedRoom(room.data);
    // 서버가 공부시간(todaySec)을 주지 않으면 지금까지 센 시간을 이어 간다 — 새 멤버가 들어와 목록을 다시 받을 때마다
    // 모두의 시간이 0으로 돌아가던 문제
    setMembers(carryStudyTime(members, membersAt, room.data.members, now));
    setMembersAt(now);
  }
  useEffect(() => {
    if (!history.data) return;
    const confirmed = new Set(
      history.data.filter((m) => m.senderId === myId && m.clientId).map((m) => m.clientId!),
    );
    if (myId)
      for (const entry of pending.current.filter((item) => confirmed.has(item.clientId))) {
        try {
          removeChatOutbox(myId, id, entry.clientId);
          pending.current = pending.current.filter((item) => item.clientId !== entry.clientId);
        } catch {
          toast('전송 확인을 기기에 저장하지 못했어요');
        }
      }
    // 네트워크에서 읽은 기록과 화면의 대기 메시지를 합친다.
    // 같은 메시지는 서버에서 새로 읽은 값을 쓴다(첨부의 읽기 주소는 1시간 뒤 만료돼, 다시 읽으면 새 주소가 온다)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMsgs((current) => {
      const fromServer = new Set(history.data!.map((m) => m._id));
      return [
        ...history.data!,
        ...current.filter((m) => !confirmed.has(m._id) && !fromServer.has(m._id)),
      ];
    });
  }, [history.data, myId, id]);
  // 방 구독(room:join). 소켓이 다시 붙을 때와, 소켓은 살아 있는데 HTTP 실패로만 끊김 상태였다가 돌아올 때
  // 모두 부른다. 마지막으로 보낸 요청의 응답만 반영해, 둘이 겹쳐도 대기 메시지를 한 번만 보낸다
  const joinAttempt = useRef(0);
  const joinAckTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const joinRoom = () => {
    const attempt = ++joinAttempt.current;
    clearTimeout(joinAckTimer.current);
    setChatJoinFailed(false);
    joinAckTimer.current = setTimeout(() => {
      if (attempt !== joinAttempt.current) return;
      joinAttempt.current++;
      joinedChat.current = false;
      setJoinedRoom(null);
      setChatJoinFailed(true);
    }, ACK_TIMEOUT_MS);
    socket.emit('room:join', { roomId: id }, (r) => {
      if (attempt !== joinAttempt.current) return;
      clearTimeout(joinAckTimer.current);
      joinAckTimer.current = undefined;
      if (!r.ok) setChatJoinFailed(true);
      joinedChat.current = r.ok;
      setJoinedRoom(r.ok ? id : null);
      if (r.ok) {
        flushPending();
        if (chatId.data) void history.refetch();
        // 소켓 재접속 때도 서버가 계산한 현재 타이머 단계를 다시 받는다.
        void room.refetch();
      }
      if (r.missed)
        setMsgs((p) => [...new Map([...p, ...r.missed!].map((m) => [m._id, m])).values()]);
    });
  };
  useEffect(() => {
    const epochRef = syncEpoch;
    const attempts = joinAttempt;
    const onConnection = (connected: boolean) => {
      setSocketConnected(connected);
      if (!connected) {
        clearTimeout(joinAckTimer.current);
        setChatJoinFailed(false);
        attempts.current++;
        epochRef.current++;
        joinedChat.current = false;
        inFlight.current.clear();
        setJoinedRoom(null);
        return;
      }
      joinRoom();
    };
    const unsubscribe = socket.onConnection?.(onConnection);
    if (!socket.onConnection) onConnection(true);
    return () => {
      // 화면을 떠난 뒤 늦게 온 구독 응답은 버린다
      attempts.current++;
      clearTimeout(joinAckTimer.current);
      unsubscribe?.();
      epochRef.current++;
      joinedChat.current = false;
      setJoinedRoom(null);
      socket.emit('room:leave', { roomId: id });
    };
  }, [id, myId, chatId.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useSocket(
    'room:presence',
    (p) => {
      if (p.roomId !== id) return;
      const at = Date.now();
      // 소켓 처리 함수는 처음 값을 기억하므로 이전 목록 · 시각은 최신 값(함수형 갱신 · ref)으로 읽는다
      setMembers((prev) => carryStudyTime(prev, membersAtRef.current, p.members, at));
      setMembersAt(at);
    },
    [id],
  );

  useSocket(
    'room:members-changed',
    (payload) => {
      if (payload.roomId !== id) return;

      void room.refetch();
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

  // p.100 연결 끊김 시나리오: 끊김 → (재연결 | 5분 넘으면 자동 퇴장). 소켓이 끊기면 useNet이 'unstable' · 'offline'이 된다
  const networkLost = useNet((s) => s.state === 'unstable' || s.state === 'offline');
  const lost = networkLost || socketConnected === false;
  // 끊김 ↔ 복구 전이 (렌더 중 상태 조정)
  useEffect(() => {
    if (!lost) return;
    syncEpoch.current++;
    joinAttempt.current++;
    clearTimeout(joinAckTimer.current);
    // 연결 상실에 맞춰 기록 조회를 중지한다.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setJoinedRoom(null);
    joinedChat.current = false;
    inFlight.current.clear();
  }, [lost]);
  if (lost && conn !== 'lost' && conn !== 'kicked') setConn('lost');
  if (!lost && conn === 'lost') setConn('back');
  // 다시 연결되면 끊긴 동안 쓴 메시지를 보내고 잠시 뒤 안내를 닫는다.
  // 끊김 상태가 되면 방 구독을 놓은 것으로 보므로(joinedChat = false), 소켓이 다시 붙지 않고 HTTP만 회복된
  // 경우에도 여기서 다시 구독한다. 소켓이 다시 붙으며 이미 보낸 구독은 이 요청이 대신한다
  useEffect(() => {
    if (conn !== 'back') return;
    if (!joinedChat.current) joinRoom();
    room.refetch();
    const t = setTimeout(() => setConn('ok'), 2600);
    return () => clearTimeout(t);
  }, [conn]); // eslint-disable-line react-hooks/exhaustive-deps

  // HTTP 실패로 끊김 상태가 된 뒤 소켓은 살아 있으면 복구 신호가 없다. 주기적으로 확인한다
  useEffect(() => {
    if (conn !== 'lost') return;
    const t = setInterval(() => void refetchRoom(), 15_000);
    return () => clearInterval(t);
  }, [conn, refetchRoom]);

  // 5분 넘게 끊기면 자동 퇴장 (공부 시간 기록은 서버에 저장돼 있다)
  useEffect(() => {
    if (conn !== 'lost') return;
    const t = setTimeout(() => setConn('kicked'), 5 * 60 * 1000);
    return () => clearTimeout(t);
  }, [conn]);

  /** 고른 사진 · 파일을 채팅 경로에 올린 뒤 첨부 메시지로 보낸다. 실패하면 말풍선 아래 「다시 보내기」 */
  const deliverAttachment = async (clientId: string) => {
    const entry = attachments.current.get(clientId);
    const chatRoomId = chatId.data;
    if (!entry || !chatRoomId || inFlight.current.has(clientId)) return;
    inFlight.current.add(clientId);
    setFailedIds((ids) => ids.filter((x) => x !== clientId));
    try {
      entry.blobUrl ??= await uploadToBlob(
        entry.kind === 'image' ? 'image' : 'document',
        entry.file,
        undefined,
        undefined,
        'chat',
      );
      const blobUrl = entry.blobUrl;
      const m = await new Promise<Message>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), ACK_TIMEOUT_MS);
        socket.emit(
          'chat:send',
          {
            chatRoomId,
            clientId,
            attachment: { blobUrl, kind: entry.kind, name: entry.file.name },
          },
          (sent) => {
            clearTimeout(timer);
            resolve(sent);
          },
        );
      });
      attachments.current.delete(clientId);
      receiveMessage(m, clientId);
    } catch (e) {
      setFailedIds((ids) => [...new Set([...ids, clientId])]);
      if (e instanceof UploadError) toast(e.message);
    } finally {
      inFlight.current.delete(clientId);
    }
  };
  /** + → 사진 · 파일 고르기. 고르면 바로 말풍선을 띄우고(올리는 중) 보낸다 */
  const pickAttachment = async (kind: 'image' | 'file') => {
    setAttach(false);
    if (!chatId.data) {
      void chatId.refetch();
      return toast('채팅을 준비하고 있어요. 잠시 후 다시 보내 주세요');
    }
    if (!myId) return toast('로그인 상태를 확인해 주세요');
    if (conn === 'lost' || !joinedChat.current) return toast('채팅에 연결된 뒤 다시 보내 주세요');
    let file: LocalFile | undefined;
    if (kind === 'image') {
      const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
      const a = r.canceled ? undefined : r.assets[0];
      // 형식은 파일 이름(확장자)으로 정한다 — 서버가 확장자와 형식이 같은지 본다
      if (a) file = { uri: a.uri, name: a.fileName ?? photoName(), size: a.fileSize };
    } else {
      const r = await DocumentPicker.getDocumentAsync({
        type: 'application/pdf',
        copyToCacheDirectory: true,
      });
      const a = r.canceled ? undefined : r.assets[0];
      if (a) file = { uri: a.uri, name: a.name, mimeType: a.mimeType, size: a.size };
    }
    if (!file || !chatId.data) return;
    const clientId = newClientId(++messageSeq.current);
    attachments.current.set(clientId, { kind, file });
    fresh.current.add(clientId);
    setChat(true);
    setMsgs((p) => [
      ...p,
      {
        _id: clientId,
        clientId,
        chatRoomId: chatId.data!,
        senderId: myId,
        type: kind,
        text: null,
        attachment: { kind, name: file.name, sizeBytes: file.size ?? 0, url: file.uri },
        sharedItemId: null,
        createdAt: new Date().toISOString(),
      },
    ]);
    void deliverAttachment(clientId);
  };
  /** 첨부 열기: 읽기 주소가 만료됐으면(1시간) 기록을 다시 읽어 새 주소로 연다 */
  const openAttachment = async (m: Message) => {
    let url = m.attachment?.url;
    if (!url) return;
    if (urlExpired(url) && !url.startsWith('file:')) {
      const fresh = await history.refetch();
      url = fresh.data?.find((x) => x._id === m._id)?.attachment?.url ?? url;
      if (urlExpired(url)) return toast('첨부를 다시 불러오지 못했어요. 잠시 뒤 다시 눌러 주세요');
    }
    // 기기 저장 모드의 file:// 첨부는 브라우저가 열지 못한다(iOS는 http(s)만). 공유 시트의 미리보기로 연다(Codex #507 재리뷰)
    if (url.startsWith('file:')) {
      const ok = await Sharing.isAvailableAsync().catch(() => false);
      if (!ok) return toast('이 기기에서는 파일을 열 수 없어요');
      return void (await Sharing.shareAsync(url).catch(() => toast('파일을 열지 못했어요')));
    }
    await WebBrowser.openBrowserAsync(url).catch(() => toast('파일을 열지 못했어요'));
  };
  // 사진이 만료된 주소라 보이지 않으면 기록을 한 번 다시 읽어 새 주소를 받는다(연달아 다시 읽지 않게 30초 간격)
  const staleAt = useRef(0);
  const refreshStale = () => {
    if (Date.now() - staleAt.current < 30_000) return;
    staleAt.current = Date.now();
    void history.refetch();
  };
  const send = () => {
    const text = v.trim();
    if (!text) return;
    if (text.length > 2000) return toast('메시지는 2,000자까지 보낼 수 있어요');
    if (!chatId.data) {
      void chatId.refetch();
      return toast('채팅을 준비하고 있어요. 잠시 후 다시 보내 주세요');
    }
    if (!myId) return toast('로그인 상태를 확인해 주세요');
    const clientId = `c${Date.now()}-${++messageSeq.current}-${Math.random().toString(36).slice(2, 10)}`;
    const entry = { clientId, chatRoomId: chatId.data, text, createdAt: new Date().toISOString() };
    try {
      addChatOutbox(myId, id, entry);
    } catch {
      return toast('메시지를 기기에 저장하지 못했어요. 다시 시도해 주세요');
    }
    pending.current.push(entry);
    fresh.current.add(clientId);
    setMsgs((p) => [
      ...p,
      {
        _id: clientId,
        clientId,
        chatRoomId: chatId.data!,
        senderId: myId ?? '',
        type: 'text',
        text,
        sharedItemId: null,
        createdAt: entry.createdAt,
      },
    ]);
    if (conn !== 'lost' && joinedChat.current) deliver(chatId.data, clientId, text);
    setV('');
  };
  if (!room.data && room.isError)
    return (
      <Canvas>
        <Screen>
          <Header title="스터디룸" />
          <Text className="mt-8 text-center text-body">스터디룸 정보를 불러오지 못했어요</Text>
          <Btn className="mt-4" onPress={() => void room.refetch()}>
            다시 시도
          </Btn>
          <Btn kind="outline" className="mt-2" onPress={leaveRoom}>
            돌아가기
          </Btn>
        </Screen>
      </Canvas>
    );
  if (!room.data) return <Loading />;
  const last = msgs[msgs.length - 1];
  // 서버 멤버 목록은 참여 기록이라 뒤로 가서 나간 사람도 남는다. 미디어에 연결돼 있으면 지금 접속한 사람(+나)만 보인다
  const here = live.connected
    ? members.filter(
        (m) => m.userId === myId || live.participantState?.(m.userId)?.present !== false,
      )
    : members;
  const tiles = chat ? here.slice(0, columns) : here;
  const remain = timer ? Math.max(0, Math.floor((timer.endsAt - now) / 1000)) : 0;

  return (
    <Canvas>
      <Screen scroll={false} pad={false} avoidKeyboard={false}>
        <View
          ref={keyboardFrame}
          className="flex-1"
          // 키보드가 가리는 만큼 화면 아래를 띄워 채팅 입력줄이 키보드 바로 위에 오게 한다
          style={{
            paddingBottom: keyboardInset,
            paddingLeft: insets.left,
            paddingRight: insets.right,
          }}
        >
          {/* 캠 · 음성이 끊겨도 같은 노란 띠로 알린다(미디어는 알아서 다시 붙는다 — useLiveRoom 재시도) */}
          {(conn === 'lost' || (!!live.reconnecting && conn !== 'kicked')) && (
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
          <View className={landscape ? 'px-4' : 'px-5'}>
            <View
              className={cx('flex-row items-center justify-between', landscape ? 'h-10' : 'h-11')}
            >
              <Pressable
                accessibilityLabel={chat ? '채팅 닫기' : '나가기'}
                onPress={back}
                hitSlop={10}
              >
                <ArrowLeft size={ICON.lg} color={C.ink} />
              </Pressable>
              {landscape && (
                <View className="flex-1 flex-row items-center gap-3 px-3">
                  <Text numberOfLines={1} className="flex-1 text-subhead font-bold text-ink">
                    {room.data.title}
                  </Text>
                  {timer && (
                    <Badge tone="dark">{`${timer.label} ${remain >= 3600 ? hms(remain) : hms(remain).slice(3)}`}</Badge>
                  )}
                  <Badge tone="gray">{`${here.length}명 접속중`}</Badge>
                </View>
              )}
              <Pressable
                accessibilityLabel="세부 설정"
                onPress={() => router.push({ pathname: '/room/settings', params: { id } })}
                hitSlop={10}
              >
                <Settings size={ICON.md} color={C.ink} />
              </Pressable>
            </View>
            {!chat && !landscape && (
              <Animated.View
                entering={SWAP_IN}
                exiting={SWAP_OUT}
                className="flex-row items-center justify-between"
              >
                <Text className="text-title3 font-bold text-ink">{room.data.title}</Text>
                <View className="flex-row gap-1">
                  {timer && (
                    <Badge tone="dark">{`${timer.label} ${remain >= 3600 ? hms(remain) : hms(remain).slice(3)}`}</Badge>
                  )}
                  <Badge tone="gray">{`${here.length}명 접속중`}</Badge>
                </View>
              </Animated.View>
            )}
          </View>
          <ScrollView
            testID="room-member-grid"
            style={chat ? { maxHeight: tileHeight + 16, flexGrow: 0, flexShrink: 1 } : { flex: 1 }}
            contentContainerStyle={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              gap: tileGap,
              paddingHorizontal: 16,
              paddingTop: landscape ? 4 : 12,
              paddingBottom: 8,
            }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {tiles.map((m) => {
              const me = m.userId === myId;
              const state = live.participantState?.(m.userId);
              const remote = me ? null : state;
              const camOn = me ? live.camOn : (remote?.camOn ?? false);
              const micOn = me ? live.micOn : (remote?.micOn ?? false);
              const speaking = micOn && !!state?.speaking;
              const video = live.video(m.userId);
              return (
                // 카메라 회전 문제를 분리 확인하기 위해 영상 타일은 애니메이션 없는 View로 표시한다.
                <View
                  key={m.userId}
                  testID={`room-member-tile-${m.userId}`}
                  style={{ width: tileWidth, height: tileHeight }}
                  className={cx(
                    'items-center justify-center rounded-2xl border-2 overflow-hidden',
                    camOn ? 'bg-night' : 'bg-white',
                    speaking ? 'border-brand' : 'border-transparent',
                  )}
                >
                  {video}
                  {speaking && (
                    <View
                      accessibilityLabel={`${m.nickname} 말하는 중`}
                      className="absolute top-2 left-2 rounded-full bg-brand p-1"
                    >
                      <Volume2 size={ICON.xs} color="#fff" />
                    </View>
                  )}
                  {camOn && (
                    <View className="absolute top-2.5 right-2.5 h-1.5 w-1.5 rounded-full bg-sun" />
                  )}
                  {!video && <Avatar uri={m.avatarUrl} name={m.nickname} size={44} />}
                  <Text
                    className={cx('text-footnote font-bold', camOn ? 'text-white' : 'text-ink')}
                  >
                    {m.nickname}
                  </Text>
                  <Text
                    className={cx(
                      'tabular-nums text-caption',
                      camOn ? 'text-white/70' : 'text-ink/60',
                    )}
                  >
                    {conn === 'lost' && !me
                      ? '연결 확인 중'
                      : hms(
                          me
                            ? mySec
                            : remote?.joinedAt !== undefined
                              ? // 그 사람이 들어온 때부터 센다(내가 들어온 때가 아니라)
                                Math.max(0, Math.floor((now - remote.joinedAt) / 1000))
                              : (ymd(seoul(membersAt)) === day ? (m.todaySec ?? 0) : 0) +
                                (conn === 'lost'
                                  ? 0
                                  : Math.max(
                                      0,
                                      Math.floor((now - Math.max(membersAt, midnight)) / 1000),
                                    )),
                        )}
                  </Text>
                  {!micOn && (
                    <View
                      accessibilityLabel={`${m.nickname} 마이크 꺼짐`}
                      className="absolute bottom-2.5 left-2.5"
                    >
                      <MicOff size={ICON.xs} color={camOn ? 'rgba(255,255,255,.5)' : C.sub} />
                    </View>
                  )}
                </View>
              );
            })}
          </ScrollView>

          {chat && chatId.isError && !chatId.data && (
            <LoadError message="채팅방을 불러오지 못했어요" retry={chatId.refetch} />
          )}
          {chat && history.isError && !history.data && (
            <LoadError message="대화 기록을 불러오지 못했어요" retry={history.refetch} />
          )}
          {chat ? (
            // 채팅은 아래에서 올라오고, 캠 조작은 아래로 내려가며 사라진다(동작 줄이기 설정이면 바로 바뀐다)
            <Animated.View
              testID="room-chat"
              entering={RISE_IN}
              exiting={SWAP_OUT}
              className="mt-2 flex-1"
            >
              <FlatList
                ref={list}
                data={msgs}
                keyExtractor={(m) => m._id}
                onContentSizeChange={() => list.current?.scrollToEnd()}
                className="flex-1"
                contentContainerClassName="gap-3 px-4 py-3"
                renderItem={({ item: m }) => {
                  const mine = m.senderId === myId;
                  return (
                    <Animated.View
                      entering={fresh.current.has(m._id) ? POP_IN : undefined}
                      className={cx(mine && 'items-end')}
                    >
                      {!mine && (
                        <View className="flex-row items-center gap-1.5 mb-1">
                          <MessageCircle size={ICON.xs} color={C.sub} />
                          <Text className="text-caption2 text-sub">
                            {m.senderNickname ?? '멤버'}
                          </Text>
                        </View>
                      )}
                      {m.type === 'shared_item' && m.sharedItemId ? (
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => void openSharedMessage(m.sharedItemId!)}
                          className="max-w-[78%] rounded-2xl bg-white px-3 py-2"
                        >
                          <Text className="text-footnote text-ink">
                            {m.text ?? '공유 자료를 보냈어요'}
                          </Text>
                          <Text className="text-caption2 text-brand">공유 자료 열기</Text>
                        </Pressable>
                      ) : (
                        <ChatBubble m={m} onOpen={openAttachment} onStale={refreshStale} />
                      )}
                      {failedIds.includes(m._id) && (
                        <Pressable
                          accessibilityRole="button"
                          onPress={() =>
                            m.type === 'image' || m.type === 'file'
                              ? void deliverAttachment(m._id)
                              : deliver(m.chatRoomId, m._id, m.text ?? '')
                          }
                        >
                          <Text className="mt-1 text-caption2 text-danger">
                            전송하지 못했어요 · 다시 보내기
                          </Text>
                        </Pressable>
                      )}
                      {mine && m.clientId === m._id && !failedIds.includes(m._id) && (
                        <Text className="mt-1 text-caption2 text-sub">
                          {conn === 'lost' || joinedRoom !== id ? '연결 후 전송 대기' : '전송 중'}
                        </Text>
                      )}
                      {mine && conn === 'back' && m === msgs[msgs.length - 1] && (
                        <Text className="mt-1 text-caption2 text-brand">자동으로 전송했어요</Text>
                      )}
                    </Animated.View>
                  );
                }}
              />
            </Animated.View>
          ) : (
            <Animated.View
              testID="room-controls"
              entering={RISE_IN}
              exiting={SINK_OUT}
              className={landscape ? 'flex-row items-center gap-3 px-4 py-1' : 'px-5 pb-2'}
            >
              <View className={cx('flex-row gap-2', landscape && 'flex-[2]')}>
                <Ctl
                  compact={landscape}
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
                  compact={landscape}
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
                  compact={landscape}
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
              <View
                className={cx(
                  'flex-row items-center rounded-2xl bg-white',
                  landscape ? 'h-11 flex-1 px-3' : 'mt-2 px-4 py-2',
                )}
              >
                <Pressable
                  onPress={() => setChat(true)}
                  accessibilityRole="button"
                  accessibilityLabel="채팅 열기"
                  className={cx(
                    'flex-1 flex-row items-center gap-2',
                    landscape ? 'h-11' : 'min-h-8',
                  )}
                >
                  <MessageCircle size={ICON.sm} color={C.sub} />
                  <Text numberOfLines={1} className="flex-1 text-caption text-sub">
                    {last
                      ? `${last.senderId === myId ? '나' : (last.senderNickname ?? '멤버')}: ${previewOf(last)}`
                      : '채팅을 시작해 보세요'}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityLabel="도구"
                  hitSlop={6}
                  onPress={() => setMenu((m) => !m)}
                  className={cx(
                    'h-8 w-8 items-center justify-center rounded-full',
                    menu ? 'bg-brand' : 'bg-mint',
                  )}
                >
                  {menu ? (
                    <X size={ICON.sm} color="#fff" />
                  ) : (
                    <Plus size={ICON.sm} color={C.brand} />
                  )}
                </Pressable>
              </View>
            </Animated.View>
          )}
          {chatJoinFailed && conn !== 'lost' && conn !== 'kicked' && (
            <Pressable accessibilityRole="button" onPress={joinRoom} className="px-5 py-2">
              <Text className="text-caption text-danger">채팅 연결에 실패했어요 · 다시 연결</Text>
            </Pressable>
          )}
          {attach && (
            <Pop className="mx-5 mt-2 flex-row gap-2 rounded-2xl bg-white p-2">
              {(
                [
                  ['image', ImageIcon, '사진'],
                  ['file', FileText, '파일 (PDF)'],
                ] as const
              ).map(([kind, Ic, label]) => (
                <Pressable
                  key={kind}
                  accessibilityRole="button"
                  accessibilityLabel={`${label} 보내기`}
                  onPress={() => void pickAttachment(kind)}
                  className="flex-1 flex-row items-center justify-center gap-2 rounded-xl bg-mint py-3"
                >
                  <Ic size={ICON.sm} color={C.brand} />
                  <Text className="text-subhead font-semibold text-ink">{label}</Text>
                </Pressable>
              ))}
            </Pop>
          )}
          {emoji && (
            <Pop className="mx-5 mt-2 flex-row flex-wrap gap-y-1 rounded-2xl bg-white px-1 py-2">
              {CHAT_EMOJIS.map((e) => (
                <Pressable
                  key={e}
                  accessibilityRole="button"
                  accessibilityLabel={`${e} 넣기`}
                  onPress={() => {
                    setChat(true);
                    setV((x) => x + e);
                  }}
                  // 한 줄 8칸 격자(16개 = 두 줄)
                  className="h-10 w-[12.5%] items-center justify-center rounded-xl active:bg-fill"
                >
                  <Text className="text-title3">{e}</Text>
                </Pressable>
              ))}
            </Pop>
          )}
          <View
            className={cx('flex-row items-center gap-3', landscape ? 'px-4 pt-1' : 'px-5 pt-3')}
            // 키보드가 올라오면 홈 표시줄 여백은 필요 없다(키보드 바로 위에 붙인다)
            style={{
              paddingBottom:
                keyboardInset > 0
                  ? landscape
                    ? 4
                    : 8
                  : Math.max(insets.bottom, landscape ? 4 : 12) + (landscape ? 4 : 8),
            }}
          >
            <View className="flex-1 flex-row items-center gap-2 rounded-full bg-white px-4">
              {/* 사진 · 파일 첨부를 고른다(키보드는 내린다) */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="사진 · 파일 첨부"
                hitSlop={8}
                onPress={() => {
                  Keyboard.dismiss();
                  setEmoji(false);
                  setAttach((x) => !x);
                }}
                className="h-6 w-6 items-center justify-center rounded-full bg-ink"
              >
                <Plus size={ICON.xs} color="#fff" />
              </Pressable>
              <TextInput
                value={v}
                onFocus={() => {
                  setChat(true);
                  setEmoji(false);
                  setAttach(false);
                }}
                onChangeText={setV}
                onSubmitEditing={send}
                returnKeyType="send"
                placeholder="채팅을 입력해 주세요"
                placeholderTextColor={C.sub}
                className="h-11 flex-1 text-footnote text-ink"
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={emoji ? '이모지 닫기' : '이모지'}
                hitSlop={8}
                onPress={() => {
                  setAttach(false);
                  // 이모지 칸은 키보드 자리를 대신한다(메신저처럼): 키보드와 함께 열면 작은 화면에서 입력줄이
                  // 다시 키보드 아래로 밀린다(Codex #507 리뷰). 입력칸을 누르면 이모지 칸을 닫고 키보드를 연다
                  if (!emoji) Keyboard.dismiss();
                  setEmoji((x) => !x);
                }}
              >
                <Smile size={ICON.md} color={emoji ? C.brand : C.sun} />
              </Pressable>
            </View>
            <Pressable
              accessibilityLabel="전송"
              onPress={send}
              className="h-11 w-11 items-center justify-center rounded-full bg-ink"
            >
              <Send size={ICON.sm} color="#fff" />
            </Pressable>
          </View>
          {chat && (
            <Animated.View
              entering={SWAP_IN}
              exiting={SWAP_OUT}
              className="absolute top-2 right-14"
            >
              <Pressable
                onPress={() => setChat(false)}
                // 오른쪽 위 설정 버튼과 겹치지 않게 그 왼쪽에 둔다
                className="rounded-full bg-black/40 px-2 py-0.5"
              >
                <Text className="text-caption2 text-white">캠 보기</Text>
              </Pressable>
            </Animated.View>
          )}

          {menu && (
            <Pop className="absolute right-5 bottom-[178px] z-20 gap-1 rounded-2xl bg-white p-1.5 shadow-lg">
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
                  className="items-center rounded-xl px-3 py-1.5 active:bg-fill"
                >
                  <Ic size={ICON.md} color={C.brand} />
                  <Text className="text-caption2 text-ink">{l}</Text>
                </Pressable>
              ))}
            </Pop>
          )}
          <Dialog open={pick} onClose={() => setPick(false)}>
            <Text className="mb-4 text-callout font-bold text-ink">학습 자료 유형 선택</Text>
            <View className="w-full flex-row gap-2">
              <Pressable
                onPress={() => {
                  setPick(false);
                  router.push({ pathname: '/room/library', params: { id, type: 'quiz' } });
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
                  router.push({ pathname: '/room/library', params: { id, type: 'flashcards' } });
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
        </View>
      </Screen>
    </Canvas>
  );
}

const Ctl = ({
  on,
  onPress,
  icon,
  label,
  sub,
  strong,
  compact = false,
}: {
  on: boolean;
  onPress: () => void;
  icon: React.ReactNode;
  label: string;
  sub?: string;
  strong?: boolean;
  compact?: boolean;
}) => (
  <Pressable
    onPress={onPress}
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityHint={sub}
    accessibilityState={{ selected: on }}
    className={cx(
      'flex-1 items-center justify-center',
      compact ? 'h-11 flex-row gap-1.5 rounded-xl px-2' : 'h-14 gap-0.5 rounded-2xl',
      strong && on ? 'border border-brand/30 bg-mint' : 'bg-white',
    )}
  >
    {icon}
    <Text
      numberOfLines={1}
      className={cx(
        'text-caption2 font-semibold',
        !compact && 'mt-0.5',
        on ? 'text-ink' : 'text-sub',
      )}
    >
      {label}
    </Text>
    {sub && !compact && <Text className="text-caption2 text-sub">{sub}</Text>}
  </Pressable>
);

export function RoomCardsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const openFeature = useFeatureNavigation();
  const shared = useQuery({ queryKey: ['room-shared', id], queryFn: () => api.rooms.shared(id) });
  const others = shared.data?.items.filter((i) => i.itemType !== 'flashcards') ?? [];
  const qc = useQueryClient();
  const opening = useRef(new Set<string>());
  // 공유 항목에는 노트 종류가 없어서 노트를 조회해 종류에 맞는 화면으로 연다(상세 화면과 같은 캐시 키)
  const openMaterial = async (item: RoomSharedItem, materialId: string) => {
    if (opening.current.has(item._id)) return;
    opening.current.add(item._id);
    try {
      const note = await qc.fetchQuery({
        queryKey: ['material', materialId],
        queryFn: () => api.content.material(materialId),
        staleTime: 30_000,
      });
      const pathname =
        note.kind === 'handwriting'
          ? '/(tabs)/note/hand/[id]'
          : note.kind === 'recording'
            ? '/(tabs)/note/rec/[id]'
            : '/(tabs)/note/doc/[id]';
      openFeature({ pathname, params: { id: materialId } });
    } catch {
      toast('이 자료를 열 수 없어요');
    } finally {
      opening.current.delete(item._id);
    }
  };
  const openItem = (item: RoomSharedItem) => {
    if (item.itemType === 'quiz' && item.quizSetId)
      openFeature({ pathname: '/play/solve', params: { setId: item.quizSetId, from: 'room' } });
    else if (item.itemType === 'material' && item.materialId)
      void openMaterial(item, item.materialId);
    else toast('이 자료를 열 수 없어요');
  };
  const [flip, setFlip] = useState<string[]>([]);
  const owner = shared.data?.items.find((i) => i.itemType === 'flashcards')?.sharedByNickname;
  return (
    <Canvas>
      <Screen>
        <Pressable
          onPress={() => router.back()}
          className="mt-3 flex-row items-center gap-2 self-start rounded-full bg-white px-3 py-1.5"
        >
          <ArrowLeft size={ICON.sm} color={C.ink} />
          <Text className="text-footnote text-ink">뒤로 가기</Text>
        </Pressable>
        {shared.isError && !shared.data && (
          <LoadError message="공유 자료를 불러오지 못했어요" retry={shared.refetch} />
        )}
        {shared.isSuccess && others.length === 0 && shared.data.flashcards.length === 0 && (
          <Text className="py-12 text-center text-footnote text-sub">
            아직 공유된 자료가 없어요
          </Text>
        )}
        {others.map((item) => (
          <Pressable
            key={item._id}
            accessibilityRole="button"
            onPress={() => openItem(item)}
            className="mt-3 flex-row items-center justify-between rounded-xl bg-white px-4 py-3"
          >
            <Text className="flex-1 text-footnote font-semibold text-ink">{item.title}</Text>
            <Text className="text-caption2 text-sub">
              {item.sharedByNickname} · {item.itemType === 'quiz' ? '퀴즈' : '자료'}
            </Text>
          </Pressable>
        ))}
        {!!shared.data?.flashcards.length && (
          <Text className="mt-3 text-caption text-sub">
            {owner ? `${owner}님이 공유한 플래시 카드` : '공유된 플래시 카드'} · 탭해서 뒤집기
          </Text>
        )}
        <View className="mt-3 flex-row flex-wrap justify-between gap-y-3">
          {shared.data?.flashcards.map((c) => {
            const on = flip.includes(c._id);
            return (
              <Pressable
                key={c._id}
                onPress={() => setFlip((p) => (on ? p.filter((x) => x !== c._id) : [...p, c._id]))}
                className={cx(
                  'h-36 w-[48.5%] items-center justify-center rounded-2xl border p-3',
                  on ? 'border-brand bg-brand' : 'border-transparent bg-mint',
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
    </Canvas>
  );
}

/** 채팅 목록 위 한 줄 미리보기 */
const previewOf = (m: Message) =>
  m.type === 'image'
    ? '사진'
    : m.type === 'file'
      ? `파일 · ${m.attachment?.name ?? ''}`
      : (m.text ?? '공유 자료');

const sizeLabel = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)}MB`
    : `${Math.max(1, Math.round(bytes / 1024))}KB`;

/** 서명된 읽기 주소(SAS)의 만료 시각(se)이 지났거나 1분 안에 지나는지. se가 없으면 만료되지 않는 주소로 본다 */
export const urlExpired = (url: string, now = Date.now()) => {
  const se = /[?&]se=([^&]+)/.exec(url)?.[1];
  if (!se) return false;
  const at = Date.parse(decodeURIComponent(se));
  return Number.isFinite(at) && at - now < 60_000;
};

/** 말풍선: 글 · 사진(눌러서 크게) · 파일(눌러서 열기) */
function ChatBubble({
  m,
  onOpen,
  onStale,
}: {
  m: Message;
  onOpen: (m: Message) => void;
  onStale: () => void;
}) {
  const a = m.attachment;
  const open = () => onOpen(m);
  if (m.type === 'image' && a)
    return (
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={`사진 ${a.name} 크게 보기`}
        onPress={open}
      >
        <Image
          source={{ uri: a.url }}
          className="h-44 w-44 rounded-2xl bg-fill"
          resizeMode="cover"
          onError={() => {
            if (urlExpired(a.url)) onStale();
          }}
        />
      </Pressable>
    );
  if (m.type === 'file' && a)
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`파일 ${a.name} 열기`}
        onPress={open}
        className="max-w-[78%] flex-row items-center gap-2.5 rounded-2xl bg-white px-3 py-2.5"
      >
        <View className="h-9 w-9 items-center justify-center rounded-xl bg-mint">
          <FileText size={ICON.sm} color={C.brand} />
        </View>
        <View className="shrink">
          <Text numberOfLines={1} className="text-footnote font-semibold text-ink">
            {a.name}
          </Text>
          {a.sizeBytes > 0 && (
            <Text className="text-caption2 text-sub">{sizeLabel(a.sizeBytes)}</Text>
          )}
        </View>
      </Pressable>
    );
  return (
    <View className="max-w-[78%] rounded-2xl bg-white px-3 py-2">
      <Text className="text-footnote text-ink">
        {m.type === 'image' || m.type === 'file'
          ? '첨부를 불러오지 못했어요'
          : (m.text ?? '공유 자료를 보냈어요')}
      </Text>
    </View>
  );
}

/** 보낼 메시지의 기기 쪽 식별자(재전송 때 같은 메시지로 묶는다) */
const newClientId = (seq: number) =>
  `c${Date.now()}-${seq}-${Math.random().toString(36).slice(2, 10)}`;
/** 이름 없이 고른 사진의 파일 이름 */
const photoName = () => `photo-${Date.now()}.jpg`;

/**
 * 멤버 목록을 새로 받을 때 각자의 오늘 공부시간(todaySec)을 이어 간다.
 * 서버가 값을 주면 그 값을 쓰고, 주지 않으면 이전 목록의 값 + 그 뒤 흐른 시간(서울 날짜가 바뀌었으면 자정부터)을 쓴다.
 * 새로 들어온 멤버는 0부터 센다
 */
export function carryStudyTime(
  prev: RoomMember[],
  prevAt: number,
  next: RoomMember[],
  at: number,
): RoomMember[] {
  const today = ymd(seoul(at));
  const midnight = Date.parse(`${today}T00:00:00+09:00`);
  const sameDay = ymd(seoul(prevAt)) === today;
  const counted = new Map(
    prev.map((m) => [
      m.userId,
      (sameDay ? (m.todaySec ?? 0) : 0) +
        Math.max(0, Math.floor((at - Math.max(prevAt, midnight)) / 1000)),
    ]),
  );
  return next.map((m) =>
    m.todaySec !== undefined || !counted.has(m.userId)
      ? m
      : { ...m, todaySec: counted.get(m.userId)! },
  );
}
