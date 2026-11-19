import { useEffect, useState } from 'react';
import { useIsFocused } from 'expo-router';
import { socket } from '@/lib/socket';

// 소켓 하나를 목록 · 방 화면이 함께 쓰고 서버의 지켜보기는 소켓 · 방마다 하나라, 같은 방을 여럿이 보면 마지막이 그만 볼 때만 푼다
const watching = new Map<string, number>();

/**
 * 방마다 지금 방 화면에 들어와 있는 사람(서버 rooms:watch → room:live). 스터디룸 목록 카드와,
 * 방 안에서 캠 · 음성이 붙기 전(또는 실패 · 다시 연결 중)에 쓴다. 아직 모르는 방은 값이 없다(undefined).
 * 화면이 보이는 동안만 지켜보고, 소켓이 다시 붙으면 다시 지켜본다. 끊긴 동안 · 떠난 뒤는 모르니 비운다
 */
export function useRoomsLive(roomIds: string[]) {
  const focused = useIsFocused();
  const [live, setLive] = useState<Record<string, string[]>>({});
  const key = [...roomIds].sort().join(',');
  useEffect(() => {
    if (!focused || !key) return;
    const ids = key.split(',');
    for (const id of ids) watching.set(id, (watching.get(id) ?? 0) + 1);
    let alive = true;
    const watch = (connected: boolean) => {
      if (!connected) return setLive({});
      socket.emit('rooms:watch', { roomIds: ids }, (r) => {
        if (alive && r?.ok) setLive(r.live);
      });
    };
    const offConnection = socket.onConnection?.(watch);
    if (!socket.onConnection) watch(true);
    const offLive = socket.on('room:live', (p) => {
      if (alive && ids.includes(p.roomId)) setLive((prev) => ({ ...prev, [p.roomId]: p.userIds }));
    });
    return () => {
      alive = false;
      offConnection?.();
      offLive();
      const last = ids.filter((id) => {
        const n = (watching.get(id) ?? 1) - 1;
        if (n > 0) watching.set(id, n);
        else watching.delete(id);
        return n <= 0;
      });
      if (last.length) socket.emit('rooms:unwatch', { roomIds: last });
      setLive({});
    };
  }, [focused, key]);
  return live;
}
