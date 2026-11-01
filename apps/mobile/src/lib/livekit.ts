import { useEffect, useState } from 'react';
import { loadMedia } from './livekit-loader';
import { env } from './env';
import { socket } from './socket';
import { toast } from '@/stores/toast';
import type { MediaConnection } from './livekit-native';

/** 실제 미디어 연결이 성공한 후에만 제어 상태를 표시한다. */
export function useLiveRoom(roomId: string, enabled = true, generation = 0) {
  const [connection, setConnection] = useState<{
    id: string;
    generation: number;
    room: MediaConnection;
  } | null>(null);
  const [, update] = useState(0);
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);
  useEffect(() => {
    let alive = true;
    let activeRoom: MediaConnection | null = null;
    if (enabled && !env.useMock) {
      loadMedia()
        .then(({ connectMedia }) => connectMedia(roomId, () => alive && update((n) => n + 1)))
        .then(async (room) => {
          if (!alive) {
            await room.close();
            return;
          }
          activeRoom = room;
          setFailure(null);
          setConnection({ id: roomId, generation, room });
        })
        .catch(() => {
          if (alive)
            setFailure({ id: roomId, message: '캠·음성을 연결하지 못했어요. 다시 입장해 주세요' });
        });
    }
    return () => {
      alive = false;
      activeRoom?.close().catch(() => {});
    };
  }, [roomId, enabled, generation]);
  const room =
    enabled && connection?.id === roomId && connection.generation === generation
      ? connection.room
      : null;
  const control = async (action: 'toggleMic' | 'toggleCam' | 'toggleHearing') => {
    if (!room?.connected)
      return toast(
        env.useMock
          ? '캠·음성은 실제 서버 연결에서 사용할 수 있어요'
          : '캠·음성 연결을 확인해 주세요',
      );
    try {
      await room[action]();
      update((n) => n + 1);
    } catch {
      toast('미디어 설정을 바꾸지 못했어요. 권한과 연결을 확인해 주세요');
    }
  };
  const micOn = room?.micOn ?? false;
  const camOn = room?.camOn ?? false;
  useEffect(() => {
    if (room?.connected) socket.emit('room:state', { roomId, micOn, camOn, todaySec: 0 });
  }, [roomId, micOn, camOn, room]);
  return {
    connected: room?.connected ?? false,
    micOn,
    camOn,
    hearing: room?.hearing ?? false,
    error: failure?.id === roomId ? failure.message : null,
    toggleMic: () => control('toggleMic'),
    toggleCam: () => control('toggleCam'),
    toggleHearing: () => control('toggleHearing'),
    video: (userId: string) => room?.video(userId) ?? null,
  };
}
