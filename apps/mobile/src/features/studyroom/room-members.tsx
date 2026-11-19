import { View } from 'react-native';
import { Text } from '@/components/text';
import { useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { toast } from '@/stores/toast';
import { useAuth } from '@/stores/auth';
import { Avatar, Badge, Btn, Canvas, Group, Header, Row, Screen } from '@/components/ui';
import { LoadError } from './tools';

/** 스터디룸 멤버 창(방 설정 → 「멤버 n명」): 이 방에 가입한 사람 전부(지금 접속 여부와 상관없이)와 친구 요청 (FR-16) */
export function RoomMembersScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const myId = useAuth((s) => s.userId);
  const qc = useQueryClient();
  const room = useQuery({ queryKey: ['room', id], queryFn: () => api.rooms.get(id) });
  const friends = useQuery({ queryKey: ['friends'], queryFn: api.social.friends });
  const received = useQuery({ queryKey: ['friend-requests'], queryFn: api.social.received });
  const sentTo = useQuery({ queryKey: ['friend-requests', 'sent'], queryFn: api.social.sent });
  // 상대가 먼저 보낸 요청이 있을 때 요청하면 서버가 수락으로 처리해 친구가 되므로 친구 목록도 다시 읽는다
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['friends'] }),
      qc.invalidateQueries({ queryKey: ['friend-requests'] }),
    ]);
  const fail = (fallback: string) => (e: unknown) =>
    toast(e instanceof ApiError && e.status < 500 ? e.message : fallback);
  const request = useMutation({
    mutationFn: (userId: string) => api.social.sendRequest(userId),
    onSuccess: () => {
      toast('친구 요청을 보냈어요');
      return refresh();
    },
    onError: fail('친구 요청을 보내지 못했어요. 다시 시도해주세요'),
  });
  const accept = useMutation({
    mutationFn: (requestId: string) => api.social.respond(requestId, true),
    onSuccess: () => {
      toast('친구가 됐어요');
      return refresh();
    },
    onError: fail('요청을 수락하지 못했어요. 다시 시도해주세요'),
  });
  // 세 가지를 다 받기 전에는 버튼을 그리지 않는다(잘못된 버튼을 잠깐 보였다 바꾸지 않게)
  const known = friends.isSuccess && received.isSuccess && sentTo.isSuccess;
  const members = room.data?.members ?? [];

  const action = (userId: string) => {
    if (userId === myId) return <Badge tone="gray">나</Badge>;
    if (!known) return null;
    if (friends.data.some((f) => f.userId === userId))
      return (
        <Btn small kind="outline" disabled>
          친구
        </Btn>
      );
    const incoming = received.data.find((r) => r.requester.userId === userId);
    if (incoming)
      return (
        <Btn
          small
          loading={accept.isPending && accept.variables === incoming._id}
          onPress={() => accept.mutate(incoming._id)}
        >
          수락
        </Btn>
      );
    if (sentTo.data.includes(userId))
      return (
        <Btn small kind="outline" disabled>
          요청 보냄
        </Btn>
      );
    return (
      <Btn
        small
        kind="outline"
        loading={request.isPending && request.variables === userId}
        onPress={() => request.mutate(userId)}
      >
        친구 요청
      </Btn>
    );
  };

  return (
    <Canvas>
      <Screen>
        <Header title={room.data ? `멤버 ${members.length}명` : '멤버'} center />
        {room.isError && !room.data && (
          <LoadError message="방 멤버를 불러오지 못했어요" retry={room.refetch} />
        )}
        {(friends.isError || received.isError || sentTo.isError) && (
          <LoadError
            message="친구 상태를 불러오지 못했어요"
            retry={() =>
              void Promise.all([friends.refetch(), received.refetch(), sentTo.refetch()])
            }
          />
        )}
        <Group className="mt-2">
          {members.map((m) => (
            <View key={m.userId} testID={`member-${m.userId}`}>
              <Row right={action(m.userId)}>
                <View className="flex-row items-center gap-3">
                  <Avatar name={m.nickname} uri={m.avatarUrl} size={36} tone="mint" />
                  <View className="flex-1">
                    <Text className="text-callout text-ink">{m.nickname}</Text>
                    {/* 방장 표시는 이름 아래(Row 의 sub 는 아바타까지 감싼 칸 아래에 붙어 줄이 어긋난다) */}
                    {m.role === 'host' && <Text className="text-caption text-sub">방장</Text>}
                  </View>
                </View>
              </Row>
            </View>
          ))}
        </Group>
      </Screen>
    </Canvas>
  );
}
