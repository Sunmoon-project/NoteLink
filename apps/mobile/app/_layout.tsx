import '../global.css';
import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as SplashScreen from 'expo-splash-screen';
import * as ScreenOrientation from 'expo-screen-orientation';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/query';
import { connectSocket } from '@/lib/socket';
import { startPresence } from '@/lib/presence';
import { forgetPushRegistration, registerPush } from '@/lib/push';
import { useAuth } from '@/stores/auth';
import { DRAWER_SCREEN } from '@/features/social/drawer';
import { AppOverlays } from '@/components/AppOverlays';
import { useOfflineCache } from '@/lib/offline-cache';
import { useScreenBackground } from '@/lib/shop-themes';
import { WeeklyGoalNotifications } from '@/features/session/weekly-goal-notifications';
import { usePushTaps } from '@/features/notifications/push-taps';

/** 설정 「오프라인 캐시」(QueryClientProvider 안에서) */
function OfflineCache() {
  useOfflineCache();
  return null;
}

/** 화면 쌓기. 바탕은 장착한 상점 테마를 따른다(테마 조회가 있어 QueryClientProvider 안에서) */
function AppStack() {
  const screenBg = useScreenBackground();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: screenBg },
        // 앞으로 가면 오른쪽에서 들어오고 뒤로 가면 오른쪽으로 나간다 (두 플랫폼 같게)
        animation: 'slide_from_right',
        animationDuration: 280,
      }}
    >
      {/* 친구 창은 홈 위에 겹쳐 뜬다. 투명 모달은 띄우기 전에 정해져야 해서 여기서 선언한다 */}
      <Stack.Screen name="friends" options={DRAWER_SCREEN} />
      {/* 공부 종료 요약도 같은 이유: 화면 안에서 정하면 카드로 쌓인 뒤 모달로 바뀌며 다시 만들어져
          실기기(Release)에서 까만 화면으로 멈췄다 */}
      <Stack.Screen
        name="summary"
        options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }}
      />
    </Stack>
  );
}

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const ready = useAuth((s) => s.ready);
  const token = useAuth((s) => s.tokens?.accessToken);
  const onboarded = useAuth((s) => s.onboarded);
  useEffect(() => {
    useAuth.getState().load();
    // 기본은 세로 고정, 자동 측정 화면만 가로 (p.49)
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
  }, []);
  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);
  // 로그인되면 실시간 연결 · 푸시 토큰 등록
  useEffect(() => {
    // 로그아웃하면 이 기기의 서버 푸시 등록도 없던 것으로 본다(작업 완료는 로컬 알림으로)
    if (!token) return forgetPushRegistration();
    connectSocket();
    // 실패하면(권한 거부 · 네트워크) 서버 푸시 없이 지낸다. 원인을 찾을 수 있게 남긴다
    registerPush().catch((e: unknown) => console.warn('[push] 기기 등록 실패', e));
  }, [token]);
  // 약관 · 프로필 설정 전에는 알림을 눌러도 그 화면으로 보내지 않는다
  usePushTaps(!!token && onboarded);
  // 로그인한 동안 친구에게 접속 상태를 알린다(앞에 있을 때만, 나가면 거둔다)
  const signedIn = !!token;
  useEffect(() => (signedIn ? startPresence() : undefined), [signedIn]);
  if (!ready) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <WeeklyGoalNotifications />
        <StatusBar style="dark" />
        <AppStack />
        <AppOverlays />
        <OfflineCache />
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
