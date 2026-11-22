import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, View } from 'react-native';
import { Pressable } from '@/components/press';
import { Text, TextInput } from '@/components/text';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronLeft,
  FileText,
  ImageIcon,
  Images,
  MoreHorizontal,
  Plus,
  Search as SearchIcon,
} from 'lucide-react-native';
import type { Message, User } from '@notelink/shared';
import { api, ApiError } from '@/lib/api';
import { socket } from '@/lib/socket';
import { viewingChat } from '@/lib/notification-route';
import { useChatMute } from '@/features/notifications';
import { seoul, timeAgo, ymd } from '@/lib/dates';
import { useSocket } from '@/hooks';
import { toast } from '@/stores/toast';
import {
  Avatar,
  Btn,
  Canvas,
  Card,
  Dialog,
  Group,
  Header,
  LIST_LAYOUT,
  Row,
  Screen,
  Search,
  Sheet,
  Toggle,
  Two,
  cx,
} from '@/components/ui';
import { useAuth } from '@/stores/auth';
import { C, ICON, MOTION } from '@/theme';
import { StatusText } from './drawer';
import { UploadError } from '@/lib/upload';
import { useOpenFriendShare } from '@/features/content/friend-share';
import {
  AttachPicker,
  ChatBubble,
  newClientId,
  openChatAttachment,
  pendingMessage,
  pickChatFile,
  sendChatAttachment,
  type AttachmentKind,
  type PendingAttachment,
} from '@/features/chat/attachment';

// p.53~55 친구 추가 · 요청 · 채팅 · 삭제

const DIRECT_MESSAGE_PAGE_SIZE = 50;

type DirectHistory = { messages: Message[]; hasMore: boolean; nextBefore?: string };

function mergeMessages(...groups: Message[][]): Message[] {
  return [...new Map(groups.flat().map((message) => [message._id, message])).values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a._id.localeCompare(b._id),
  );
}

export function FriendAddScreen() {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [sent, setSent] = useState<string[]>([]);
  // 예전에 보낸 대기 중 요청도 「요청 보냄」으로(다시 열어도)
  const sentBefore = useQuery({ queryKey: ['friend-requests', 'sent'], queryFn: api.social.sent });
  const result = useQuery({
    queryKey: ['user-search', q],
    queryFn: () => api.social.search(q),
    enabled: q.trim().length > 0,
  });
  const send = useMutation({
    mutationFn: (userId: string) => api.social.sendRequest(userId),
    // 서버가 이유를 알려 주면(이미 친구예요 · 나에게는 보낼 수 없어요 등) 그 문구를 보여 준다
    onError: (e) =>
      toast(
        e instanceof ApiError && e.status < 500
          ? e.message
          : '친구 요청을 보내지 못했어요. 다시 시도해주세요',
      ),
    onSuccess: (_, userId) => {
      setSent((p) => [...p, userId]);
      // 스터디룸 멤버 창도 같은 「보낸 요청」을 본다
      void qc.invalidateQueries({ queryKey: ['friend-requests', 'sent'] });
      toast('친구 요청을 보냈어요');
    },
  });
  const found = result.data ?? [];
  return (
    <Canvas>
      <Screen>
        <Header title="친구 추가" />
        <Search
          value={q}
          onChangeText={(v) => {
            setQ(v);
          }}
          placeholder="닉네임을 입력해주세요."
        />
        {!q && (
          <Text className="mt-4 text-center text-caption text-sub">
            닉네임으로 친구를 찾아보세요 · 예) 홍길동
          </Text>
        )}
        {q.trim() && result.isError && (
          <View className="gap-2 py-3">
            <Text className="text-footnote text-sub">친구를 찾지 못했어요</Text>
            <Btn small onPress={() => void result.refetch()}>
              검색 다시 시도
            </Btn>
          </View>
        )}
        {q.trim() && result.isSuccess && found.length === 0 && (
          <Card className="mt-3 items-center py-10">
            <SearchIcon size={ICON.lg} color={C.sub} />
            <Text className="mt-2 text-subhead font-semibold text-ink">해당 친구는 없습니다.</Text>
            <Text className="text-caption text-sub">닉네임을 정확히 입력했는지 확인해주세요</Text>
          </Card>
        )}
        {found.length > 0 && (
          <Text className="mt-4 text-caption text-sub">검색 결과 {found.length}</Text>
        )}
        {found.map((u) => {
          const done = sent.includes(u.userId) || !!sentBefore.data?.includes(u.userId);
          return (
            <View key={u.userId} className="mt-2 gap-2 border-b border-fill py-3">
              <View className="flex-row items-center gap-3">
                <Avatar name={u.nickname} size={40} tone="mint" />
                <View>
                  <Text className="text-callout font-semibold text-ink">{u.nickname}</Text>
                  <Text className="text-caption text-sub">
                    {u.handle} · 함께 아는 친구 {u.mutualCount ?? 0}명
                  </Text>
                </View>
              </View>
              <Btn
                small
                kind={done ? 'outline' : 'primary'}
                disabled={done}
                loading={send.isPending && send.variables === u.userId}
                onPress={() => send.mutate(u.userId)}
              >
                {done ? '요청 보냄' : '친구 요청 보내기'}
              </Btn>
            </View>
          );
        })}
      </Screen>
    </Canvas>
  );
}

export function RequestsScreen() {
  const qc = useQueryClient();
  const reqs = useQuery({ queryKey: ['friend-requests'], queryFn: api.social.received });
  const respond = useMutation({
    mutationFn: ({ id, ok }: { id: string; ok: boolean; name: string }) =>
      api.social.respond(id, ok),
    onSuccess: (_, v) => {
      qc.invalidateQueries({ queryKey: ['friend-requests'] });
      qc.invalidateQueries({ queryKey: ['friends'] });
      if (v.ok) toast(`${v.name}님과 친구가 됐어요`);
    },
    onError: () => toast('친구 요청 처리에 실패했어요. 다시 시도해주세요'),
  });
  return (
    <Canvas>
      <Screen>
        <Header title={`받은 친구 요청 (${reqs.data?.length ?? 0})`} />
        {reqs.isError && !reqs.data && (
          <View className="gap-2 py-3">
            <Text className="text-footnote text-sub">친구 요청을 불러오지 못했어요</Text>
            <Btn small onPress={() => void reqs.refetch()}>
              친구 요청 다시 시도
            </Btn>
          </View>
        )}
        {reqs.data?.length === 0 && (
          <Text className="py-16 text-center text-footnote text-sub">받은 친구 요청이 없어요</Text>
        )}
        <View className="gap-5">
          {reqs.data?.map((r) => (
            <Animated.View
              key={r._id}
              layout={LIST_LAYOUT}
              entering={FadeIn.duration(MOTION.enter)}
              exiting={FadeOut.duration(MOTION.exit)}
            >
              <View key={r._id}>
                <View className="flex-row items-center gap-3">
                  <Avatar name={r.requester.nickname} size={36} tone="mint" />
                  <View>
                    <Text className="text-callout font-semibold text-ink">
                      {r.requester.nickname}
                    </Text>
                    <Text className="text-caption text-sub">
                      {r.requester.handle} · {timeAgo(r.requestedAt)} 요청
                    </Text>
                  </View>
                </View>
                <View className="mt-2">
                  <Two>
                    <Btn
                      small
                      onPress={() =>
                        respond.mutate({ id: r._id, ok: true, name: r.requester.nickname })
                      }
                    >
                      수락
                    </Btn>
                    <Btn
                      small
                      kind="outline"
                      onPress={() =>
                        respond.mutate({ id: r._id, ok: false, name: r.requester.nickname })
                      }
                    >
                      거절
                    </Btn>
                  </Two>
                </View>
              </View>
            </Animated.View>
          ))}
        </View>
      </Screen>
    </Canvas>
  );
}

export function ChatScreen() {
  const myId = useAuth((s) => s.userId);
  const {
    id,
    name = '',
    status = 'resting',
  } = useLocalSearchParams<{ id: string; name?: string; status?: User['status'] }>();
  const qc = useQueryClient();
  const room = useQuery({ queryKey: ['dm', id], queryFn: () => api.social.openDirect(id) });
  const mute = useChatMute(room.data?._id);
  // 이 채팅을 보는 동안에는 이 채팅의 새 메시지 배너를 띄우지 않는다(다른 화면으로 가면 다시 띄운다)
  const chatRoomId = room.data?._id;
  useFocusEffect(
    useCallback(() => (chatRoomId ? viewingChat(chatRoomId) : undefined), [chatRoomId]),
  );
  const pageRequestGeneration = useRef(0);
  // 보내는 중인 첨부(FR-16-03): 다시 보낼 때 고른 파일 · 이미 올린 주소를 다시 쓴다
  const attachments = useRef(new Map<string, PendingAttachment>());
  const history = useQuery({
    queryKey: ['messages', room.data?._id],
    queryFn: async (): Promise<DirectHistory> => {
      const requestGeneration = pageRequestGeneration.current;
      const roomId = room.data!._id;
      const fetched = await api.social.messages(roomId);
      const cached = qc.getQueryData<DirectHistory>(['messages', roomId]);
      const reconnectedDuringRequest = requestGeneration !== pageRequestGeneration.current;
      return {
        // 화면을 떠났다 오면 보내다 만 첨부(기기 파일 주소 말풍선)는 다시 보낼 수 없으니 버린다
        messages: mergeMessages(
          fetched,
          (cached?.messages ?? []).filter(
            (x) => x._id !== x.clientId || attachments.current.has(x._id),
          ),
        ),
        hasMore: reconnectedDuringRequest
          ? (cached?.hasMore ?? fetched.length === DIRECT_MESSAGE_PAGE_SIZE)
          : fetched.length === DIRECT_MESSAGE_PAGE_SIZE || cached?.hasMore === true,
        nextBefore:
          reconnectedDuringRequest || fetched.length !== DIRECT_MESSAGE_PAGE_SIZE
            ? cached?.nextBefore
            : fetched[0]?._id,
      };
    },
    enabled: !!room.data,
    refetchOnMount: 'always',
  });
  const [v, setV] = useState('');
  const [menu, setMenu] = useState(false);
  const [files, setFiles] = useState(false);
  const [attach, setAttach] = useState(false);
  const [del, setDel] = useState(false);
  // 헤더는 들어올 때 넘긴 상태가 아니라 친구 목록의 상태 · 아바타를 쓰고, 대화 중에도 1분마다 다시 읽는다(FR-16-01)
  const friends = useQuery({
    queryKey: ['friends'],
    queryFn: api.social.friends,
    refetchInterval: 60_000,
  });
  const friend = friends.data?.find((f) => f.userId === id);
  const inFlight = useRef(new Set<string>());
  const attachSeq = useRef(0);
  const [failedIds, setFailedIds] = useState<string[]>([]);
  const staleAt = useRef(0);
  const [olderLoading, setOlderLoading] = useState(false);
  const [olderError, setOlderError] = useState(false);
  const list = useRef<FlatList<Message>>(null);
  const olderLoadingRef = useRef(false);
  const contentHeight = useRef(0);
  const scrollOffset = useRef(0);
  const viewportHeight = useRef(0);
  const restoreScroll = useRef<{ offset: number; contentHeight: number } | null>(null);
  const didInitialScroll = useRef(false);
  const nearBottom = useRef(true);
  const receiveMessage = (m: Message) => {
    if (m.chatRoomId !== room.data?._id) return;
    // 서버가 저장한 내 메시지가 오면(응답이든 방송이든) 같은 clientId의 보내는 중 말풍선을 바꾼다
    const pending = m.senderId === myId && m.clientId !== m._id ? m.clientId : undefined;
    // 응답 시간이 지나 실패로 바뀐 뒤 늦게 와도, 남은 첨부 기록 · 실패 표시를 정리한다
    if (pending && attachments.current.delete(pending)) {
      setFailedIds((ids) => ids.filter((x) => x !== pending));
    }
    qc.setQueryData<DirectHistory>(['messages', m.chatRoomId], (previous) => ({
      messages: mergeMessages(
        (previous?.messages ?? []).filter((x) => !pending || x._id !== pending),
        [m],
      ),
      hasMore: previous?.hasMore ?? false,
      nextBefore: previous?.nextBefore,
    }));
  };
  useSocket('chat:message', (m) => m.chatRoomId === room.data?._id && receiveMessage(m), [
    room.data?._id,
  ]);

  useEffect(() => {
    const chatRoomId = room.data?._id;
    if (!chatRoomId) return;
    const join = (connected: boolean) => {
      if (!connected) return;
      socket.emit('chat:join', { chatRoomId }, (result) => {
        if (!result.ok || !result.missed) return;
        // 재접속 이전에 시작한 페이지 요청은 더 이상 최신 커서를 결정할 수 없다.
        pageRequestGeneration.current++;
        olderLoadingRef.current = false;
        setOlderLoading(false);
        setOlderError(false);
        qc.setQueryData<DirectHistory>(['messages', chatRoomId], (previous) => ({
          messages: mergeMessages(previous?.messages ?? [], result.missed!),
          hasMore: result.missed!.length === DIRECT_MESSAGE_PAGE_SIZE || previous?.hasMore === true,
          nextBefore:
            result.missed!.length === DIRECT_MESSAGE_PAGE_SIZE
              ? result.missed![0]?._id
              : previous?.nextBefore,
        }));
      });
    };
    const unsubscribe = socket.onConnection?.(join);
    if (!socket.onConnection) join(true);
    return () => {
      unsubscribe?.();
      pageRequestGeneration.current++;
      socket.emit('chat:leave', { chatRoomId });
    };
  }, [room.data?._id, qc]);

  const loadOlderMessages = async (manualRetry = false) => {
    const chatRoomId = room.data?._id;
    if (!chatRoomId) return;
    const current = qc.getQueryData<DirectHistory>(['messages', chatRoomId]) ?? history.data;
    const nextBefore = current?.nextBefore;
    if (!current?.hasMore || !nextBefore || olderLoadingRef.current || (olderError && !manualRetry))
      return;

    const requestGeneration = pageRequestGeneration.current;
    olderLoadingRef.current = true;
    setOlderLoading(true);
    setOlderError(false);
    try {
      const older = await api.social.messages(chatRoomId, nextBefore);
      if (requestGeneration !== pageRequestGeneration.current) return;
      restoreScroll.current = {
        offset: scrollOffset.current,
        contentHeight: contentHeight.current,
      };
      qc.setQueryData<DirectHistory>(['messages', chatRoomId], (previous) => ({
        messages: mergeMessages(older, previous?.messages ?? []),
        hasMore: older.length === DIRECT_MESSAGE_PAGE_SIZE,
        nextBefore: older.length === DIRECT_MESSAGE_PAGE_SIZE ? older[0]?._id : undefined,
      }));
    } catch {
      if (requestGeneration === pageRequestGeneration.current) setOlderError(true);
    } finally {
      if (requestGeneration === pageRequestGeneration.current) {
        olderLoadingRef.current = false;
        setOlderLoading(false);
      }
    }
  };

  const handleContentSizeChange = (_width: number, height: number) => {
    const anchor = restoreScroll.current;
    if (anchor) {
      const addedHeight = Math.max(0, height - anchor.contentHeight);
      list.current?.scrollToOffset({ offset: anchor.offset + addedHeight, animated: false });
      restoreScroll.current = null;
    } else if (!didInitialScroll.current && history.isSuccess) {
      didInitialScroll.current = true;
      list.current?.scrollToEnd({ animated: false });
    } else if (nearBottom.current) {
      list.current?.scrollToEnd({ animated: true });
    }
    contentHeight.current = height;
  };

  const send = () => {
    if (!v.trim() || !room.data) return;
    socket.emit(
      'chat:send',
      { chatRoomId: room.data._id, text: v.trim(), clientId: `c${Date.now()}` },
      receiveMessage,
    );
    setV('');
  };
  const deliverAttachment = async (clientId: string) => {
    const entry = attachments.current.get(clientId);
    const chatRoomId = room.data?._id;
    if (!entry || !chatRoomId || inFlight.current.has(clientId)) return;
    inFlight.current.add(clientId);
    setFailedIds((ids) => ids.filter((x) => x !== clientId));
    try {
      const m = await sendChatAttachment(chatRoomId, clientId, entry);
      attachments.current.delete(clientId);
      receiveMessage(m);
    } catch (e) {
      setFailedIds((ids) => [...new Set([...ids, clientId])]);
      if (e instanceof UploadError) toast(e.message);
    } finally {
      inFlight.current.delete(clientId);
    }
  };
  /** + → 사진 · 파일(PDF) 고르기. 고르면 바로 말풍선을 띄우고(올리는 중) 보낸다 */
  const pickAttachment = async (kind: AttachmentKind) => {
    setAttach(false);
    const chatRoomId = room.data?._id;
    if (!chatRoomId) return toast('채팅을 준비하고 있어요. 잠시 후 다시 보내 주세요');
    if (!myId) return toast('로그인 상태를 확인해 주세요');
    const file = await pickChatFile(kind);
    if (!file) return;
    const clientId = newClientId(++attachSeq.current);
    const entry = { kind, file };
    attachments.current.set(clientId, entry);
    receiveMessage(pendingMessage(chatRoomId, myId, clientId, entry));
    void deliverAttachment(clientId);
  };
  // 친구가 보낸 노트 카드(#554): 읽기 전용으로 열거나 끝난 공유면 「공유가 끝났어요」
  const openFriendShare = useOpenFriendShare();
  /** 첨부 열기: 읽기 주소가 만료됐으면(1시간) 기록을 다시 읽어 새 주소로 연다 */
  const openAttachment = (m: Message) =>
    openChatAttachment(m, async () => {
      const fresh = await history.refetch();
      return fresh.data?.messages.find((x) => x._id === m._id)?.attachment?.url;
    });
  // 사진이 만료된 주소라 보이지 않으면 기록을 한 번 다시 읽는다(연달아 다시 읽지 않게 30초 간격)
  const refreshStale = () => {
    if (Date.now() - staleAt.current < 30_000) return;
    staleAt.current = Date.now();
    void history.refetch();
  };
  // 이 대화에서 주고받은 사진 · 파일(불러온 기록 안에서, 최근 것부터)
  const shared = (history.data?.messages ?? [])
    // 보내는 중 · 실패한 내 말풍선(기기 파일 주소)은 빼고 서버에 저장된 것만
    .filter(
      (m) => (m.type === 'image' || m.type === 'file') && m.attachment && m._id !== m.clientId,
    )
    .reverse();
  const remove = useMutation({
    mutationFn: () => api.social.remove(id),
    onSuccess: async () => {
      await qc.cancelQueries({ queryKey: ['dm', id], exact: true });
      if (room.data?._id) {
        await qc.cancelQueries({ queryKey: ['messages', room.data._id], exact: true });
        qc.removeQueries({ queryKey: ['messages', room.data._id], exact: true });
      }
      qc.removeQueries({ queryKey: ['dm', id], exact: true });
      qc.invalidateQueries({ queryKey: ['friends'] });
      setDel(false);
      router.back();
      toast(`${name}님을 친구에서 삭제했어요`);
    },
    onError: () => toast('친구 삭제에 실패했어요. 다시 시도해주세요'),
  });
  const joinInvite = useMutation({
    mutationFn: (inviteCode: string) => api.rooms.join(inviteCode),
    onSuccess: async (joined) => {
      await qc.invalidateQueries({ queryKey: ['rooms'] });
      router.push({ pathname: '/room/[id]', params: { id: joined._id } });
    },
    onError: (error) =>
      toast(error instanceof ApiError ? error.message : '스터디룸에 참여하지 못했어요'),
  });

  if (room.isError && !room.data)
    return (
      <Canvas>
        <Screen>
          <Header title={name} />
          <Text className="mt-8 text-center text-body">대화를 불러오지 못했어요</Text>
          <Btn className="mt-4" onPress={() => void room.refetch()}>
            다시 시도
          </Btn>
        </Screen>
      </Canvas>
    );
  return (
    <Canvas>
      <Screen
        scroll={false}
        footer={
          <View className="gap-2">
            {attach && <AttachPicker onPick={(kind) => void pickAttachment(kind)} />}
            <View className="flex-row items-center gap-2 rounded-full bg-white pl-1.5 pr-4">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="첨부"
                onPress={() => setAttach((open) => !open)}
                hitSlop={6}
                className="h-8 w-8 items-center justify-center rounded-full bg-mint"
              >
                <Plus size={ICON.sm} color={C.brand} />
              </Pressable>
              <TextInput
                value={v}
                onChangeText={setV}
                onSubmitEditing={send}
                returnKeyType="send"
                placeholder="메시지 보내기"
                placeholderTextColor={C.sub}
                className="h-11 flex-1 text-subhead text-ink"
              />
              <Pressable onPress={send} hitSlop={8}>
                <Text className="text-footnote font-semibold text-brand">전송</Text>
              </Pressable>
            </View>
          </View>
        }
      >
        {/* 맨 위 한 줄: 뒤로 · 상대 아바타 · 이름 · 지금 상태 · 주고받은 자료 · 더보기 */}
        <View className="-mx-5 mb-3 flex-row items-center gap-2.5 border-b border-line px-3 pt-1 pb-3">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="뒤로"
            onPress={() => router.back()}
            hitSlop={10}
            className="h-control w-control items-center justify-center"
          >
            <ChevronLeft size={ICON.lg} color={C.ink} />
          </Pressable>
          <Avatar name={name} uri={friend?.avatarUrl} size={38} tone="mint" />
          <View className="flex-1">
            <Text numberOfLines={1} className="text-headline font-bold text-ink">
              {friend?.nickname ?? name}
            </Text>
            <StatusText status={friend?.status ?? status} />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="주고받은 자료"
            onPress={() => setFiles(true)}
            hitSlop={8}
            className="h-control w-control items-center justify-center"
          >
            <Images size={ICON.md} color={C.sub} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="더보기"
            onPress={() => setMenu(true)}
            hitSlop={8}
            className="h-control w-control items-center justify-center"
          >
            <MoreHorizontal size={ICON.md} color={C.sub} />
          </Pressable>
        </View>
        {history.isError && !history.data && (
          <View className="gap-2 py-3">
            <Text className="text-footnote text-sub">대화 기록을 불러오지 못했어요</Text>
            <Btn small onPress={() => void history.refetch()}>
              대화 기록 다시 시도
            </Btn>
          </View>
        )}
        <FlatList
          ref={list}
          testID="direct-chat-messages"
          data={history.data?.messages ?? []}
          keyExtractor={(m) => m._id}
          onContentSizeChange={handleContentSizeChange}
          onLayout={(event) => {
            viewportHeight.current = event.nativeEvent.layout.height;
          }}
          onScroll={(event) => {
            const offset = event.nativeEvent.contentOffset.y;
            scrollOffset.current = offset;
            nearBottom.current = contentHeight.current - viewportHeight.current - offset < 80;
            if (offset < 48) void loadOlderMessages();
          }}
          scrollEventThrottle={100}
          ListHeaderComponent={
            olderError ? (
              <Btn small kind="outline" onPress={() => void loadOlderMessages(true)}>
                이전 대화를 불러오지 못했어요 · 다시 시도
              </Btn>
            ) : olderLoading ? (
              <Text className="py-2 text-center text-caption text-sub">이전 대화 불러오는 중</Text>
            ) : null
          }
          contentContainerClassName="gap-3 pb-4"
          renderItem={({ item: m }) => {
            const mine = m.senderId === myId;
            if (m.type === 'study_room_invite' && m.studyRoomInvite)
              return (
                <View className={cx('flex-row', mine && 'justify-end')}>
                  <View className="max-w-[85%] rounded-2xl bg-white p-4">
                    <Text className="text-caption text-sub">스터디룸 초대</Text>
                    <Text className="mt-1 text-footnote font-bold text-ink">
                      {m.studyRoomInvite.title}
                    </Text>
                    <Text className="mt-1 text-caption text-sub">
                      참여 코드 {m.studyRoomInvite.inviteCode}
                    </Text>
                    <Btn
                      small
                      className="mt-3"
                      loading={joinInvite.isPending}
                      onPress={() => joinInvite.mutate(m.studyRoomInvite!.inviteCode)}
                    >
                      스터디룸 참여하기
                    </Btn>
                  </View>
                </View>
              );
            if (m.type === 'shared_item' && m.sharedItemId)
              return (
                <View className={cx(mine && 'items-end')}>
                  <ChatBubble
                    m={m}
                    onOpen={(x) => void openFriendShare(x.sharedItemId!)}
                    onStale={refreshStale}
                  />
                </View>
              );
            if (m.type === 'image' || m.type === 'file')
              return (
                <View className={cx(mine && 'items-end')}>
                  <ChatBubble m={m} onOpen={(x) => void openAttachment(x)} onStale={refreshStale} />
                  {failedIds.includes(m._id) && (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => void deliverAttachment(m._id)}
                    >
                      <Text className="mt-1 text-caption2 text-danger">
                        전송하지 못했어요 · 다시 보내기
                      </Text>
                    </Pressable>
                  )}
                </View>
              );
            return (
              <View className={cx('flex-row', mine && 'justify-end')}>
                <View
                  className={cx(
                    'max-w-[75%] rounded-2xl px-3.5 py-2',
                    mine ? 'bg-brand' : 'bg-white',
                  )}
                >
                  {/* 길게 누르면 복사 메뉴가 뜨게 글자를 고를 수 있게 한다 */}
                  <Text
                    selectable
                    className={cx('text-footnote', mine ? 'text-white' : 'text-ink')}
                  >
                    {m.text}
                  </Text>
                </View>
              </View>
            );
          }}
        />
        <Sheet open={menu} onClose={() => setMenu(false)}>
          <Group>
            <Row
              icon={Images}
              chevron
              onPress={() => {
                setMenu(false);
                setFiles(true);
              }}
            >
              주고받은 자료
            </Row>
            <Row
              sub={mute.muted ? '새 메시지 알림을 받지 않아요' : undefined}
              right={
                <Toggle
                  label="이 채팅 알림"
                  on={!mute.muted}
                  disabled={!mute.ready}
                  onChange={mute.toggle}
                />
              }
            >
              이 채팅 알림
            </Row>
            <Row
              danger
              onPress={() => {
                setMenu(false);
                setDel(true);
              }}
            >
              친구 삭제
            </Row>
          </Group>
        </Sheet>
        <Sheet open={files} onClose={() => setFiles(false)} title="주고받은 자료">
          {shared.length ? (
            <Group>
              {shared.map((m) => (
                <Row
                  key={m._id}
                  icon={m.type === 'image' ? ImageIcon : FileText}
                  sub={`${m.senderId === myId ? '나' : (friend?.nickname ?? name)} · ${ymd(seoul(m.createdAt)).slice(5).replace('-', '/')}`}
                  onPress={() => void openAttachment(m)}
                >
                  {m.attachment!.name}
                </Row>
              ))}
            </Group>
          ) : (
            <Text className="py-6 text-center text-footnote text-sub">
              아직 주고받은 사진 · 파일이 없어요
            </Text>
          )}
        </Sheet>
        <Dialog open={del} onClose={() => setDel(false)}>
          <Text className="text-body font-bold text-ink">{name}님을 친구에서 삭제할까요?</Text>
          <Text className="mt-1.5 text-caption text-sub">
            대화 내용과 공유한 시간표도 함께 사라져요
          </Text>
          <View className="mt-5 w-full">
            <Two>
              <Btn small kind="cream" onPress={() => setDel(false)}>
                취소
              </Btn>
              <Btn small kind="danger" loading={remove.isPending} onPress={() => remove.mutate()}>
                삭제
              </Btn>
            </Two>
          </View>
        </Dialog>
      </Screen>
    </Canvas>
  );
}
