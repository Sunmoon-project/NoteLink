import { AppState } from 'react-native';
import { api } from './api';
import { env } from './env';

/** 앱이 앞에 있는 동안 신호 간격. 서버는 2분 넘게 신호가 없으면 오프라인으로 본다(FriendsService PRESENCE_TTL_MS) */
export const PRESENCE_MS = 60_000;

/**
 * 친구에게 보이는 접속 상태: 앱이 앞에 있으면 바로 · 1분마다 신호를 보내고, 백그라운드로 가면 거둔다.
 * 앱이 꺼져 거두지 못해도 서버가 2분 뒤 오프라인으로 본다. 실패는 다음 신호가 메운다. 멈추는 함수를 돌려준다
 */
let stopCurrent: (() => void) | undefined;
/** 이 앱 실행의 표시. 서버가 기기별로 신호를 따로 두어, 다른 기기가 나가도 이 기기의 접속 상태가 지워지지 않는다 */
const DEVICE = Math.random().toString(36).slice(2, 12);

export function startPresence(): () => void {
  if (env.localData) return () => {};
  stopCurrent?.();
  let timer: ReturnType<typeof setInterval> | undefined;
  const send = (active: boolean) => void api.me.presence(active, DEVICE).catch(() => {});
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
  const stop = () => {
    sub.remove();
    clearInterval(timer);
    if (stopCurrent === stop) stopCurrent = undefined;
  };
  stopCurrent = stop;
  return stop;
}

/**
 * 로그아웃할 때(토큰을 지우기 전에): 신호 타이머 · 앞으로 나옴 감지를 먼저 멈추고 신호를 거둔다.
 * 멈추지 않으면 거둔 뒤 1분 타이머가 신호를 다시 보내 2분 동안 '활동 중'으로 남을 수 있다
 */
export async function leavePresence(): Promise<void> {
  stopCurrent?.();
  if (env.localData) return;
  await api.me.presence(false, DEVICE).catch(() => {});
}
