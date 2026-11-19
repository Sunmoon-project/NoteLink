import { AppState } from 'react-native';
import { api } from './api';
import { env } from './env';

/** 앱이 앞에 있는 동안 신호 간격. 서버는 2분 넘게 신호가 없으면 오프라인으로 본다(FriendsService PRESENCE_TTL_MS) */
export const PRESENCE_MS = 60_000;

/**
 * 친구에게 보이는 접속 상태: 앱이 앞에 있으면 바로 · 1분마다 신호를 보내고, 백그라운드로 가면 거둔다.
 * 앱이 꺼져 거두지 못해도 서버가 2분 뒤 오프라인으로 본다. 실패는 다음 신호가 메운다. 멈추는 함수를 돌려준다
 */
export function startPresence(): () => void {
  if (env.localData) return () => {};
  let timer: ReturnType<typeof setInterval> | undefined;
  const send = (active: boolean) => void api.me.presence(active).catch(() => {});
  const start = () => {
    clearInterval(timer);
    send(true);
    timer = setInterval(() => send(true), PRESENCE_MS);
  };
  if (AppState.currentState === 'active') start();
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active') start();
    else if (state === 'background' && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
      send(false);
    }
  });
  return () => {
    sub.remove();
    clearInterval(timer);
  };
}
