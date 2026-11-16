import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { loadMedia } from './livekit-loader';
import { env } from './env';
import { socket } from './socket';
import { toast } from '@/stores/toast';
import type { MediaConnection } from './livekit-native';

/** 실제 미디어 연결이 성공한 후에만 제어 상태를 표시한다. */
export function useLiveRoom(roomId: string, enabled = true, generation = 0, todaySec = 0) {
  const [connection, setConnection] = useState<{
    id: string;
    generation: number;
    room: MediaConnection;
  } | null>(null);
  const [, update] = useState(0);
  const [failure, setFailure] = useState<{
    id: string;
    generation: number;
    message: string;
  } | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const retryCount = useRef(0);
  useEffect(() => {
    let alive = true;
    let activeRoom: MediaConnection | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryWhenActive = false;
    const retry = () => {
      if (!alive || retryTimer) return;
      const delay = Math.min(30_000, 2_000 * 2 ** Math.min(retryCount.current++, 4));
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        if (!alive) return;
        if (AppState.currentState === 'background' || AppState.currentState === 'inactive') {
          retryWhenActive = true;
          return;
        }
        setRetryGeneration((n) => n + 1);
      }, delay);
    };
    const appState = AppState.addEventListener('change', (state) => {
      if (alive && state === 'active' && retryWhenActive) {
        retryWhenActive = false;
        setRetryGeneration((n) => n + 1);
      }
    });
    if (enabled && !env.localData) {
      loadMedia()
        .then(({ connectMedia }) =>
          connectMedia(
            roomId,
            () => alive && update((n) => n + 1),
            () => {
              if (alive) retry();
            },
          ),
        )
        .then(async (room) => {
          if (!alive) {
            await room.close();
            return;
          }
          activeRoom = room;
          retryCount.current = 0;
          setFailure(null);
          setConnection({ id: roomId, generation, room });
        })
        .catch((error: unknown) => {
          if (alive) {
            setFailure({
              id: roomId,
              generation,
              message: '캠·음성을 연결하지 못했어요. 다시 입장해 주세요',
            });
            const status =
              typeof error === 'object' && error !== null && 'status' in error
                ? error.status
                : undefined;
            // 방에서 강퇴됐거나 인증이 만료된 경우에는 자동 재접속을 반복하지 않는다.
            if (status !== 401 && status !== 403 && status !== 404) retry();
          }
        });
    }
    return () => {
      alive = false;
      clearTimeout(retryTimer);
      appState.remove();
      activeRoom?.close().catch(() => {});
    };
  }, [roomId, enabled, generation, retryGeneration]);
  const room =
    enabled && connection?.id === roomId && connection.generation === generation
      ? connection.room
      : null;
  const control = async (action: 'toggleMic' | 'toggleCam' | 'toggleHearing') => {
    if (!room?.connected)
      return toast(
        env.localData
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
    if (room?.connected) socket.emit('room:state', { roomId, micOn, camOn, todaySec });
  }, [roomId, micOn, camOn, room]); // eslint-disable-line react-hooks/exhaustive-deps -- 시간이 흐를 때마다 보내지 않는다
  return {
    connected: room?.connected ?? false,
    micOn,
    camOn,
    hearing: room?.hearing ?? false,
    error:
      failure?.id === roomId && failure.generation === generation
        ? failure.message
        : room && !room.connected
          ? '캠·음성 연결이 종료됐어요. 다시 연결해 주세요'
          : null,
    toggleMic: () => control('toggleMic'),
    toggleCam: () => control('toggleCam'),
    toggleHearing: () => control('toggleHearing'),
    participantState: (userId: string) =>
      room?.connected ? room.participantState(userId) : { camOn: false, micOn: false },
    video: (userId: string) => (room?.connected ? room.video(userId) : null),
  };
}
