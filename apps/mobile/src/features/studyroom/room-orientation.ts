import { useCallback } from 'react';
import { useFocusEffect } from 'expo-router';
import * as ScreenOrientation from 'expo-screen-orientation';

/**
 * 앱은 세로로 고정이지만(app/_layout.tsx) 스터디룸은 휴대폰을 눕혀 캠을 쓸 수 있게 방이 보이는 동안만 회전을 푼다.
 * 다른 화면으로 가면(설정 · 카드 · 나가기) 세로로 되돌린다 — 순공시간 화면(session/summary.tsx)과 같은 방식
 */
export function useRoomOrientation() {
  useFocusEffect(
    useCallback(() => {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.DEFAULT).catch(() => {});
      return () => {
        ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
      };
    }, []),
  );
}
