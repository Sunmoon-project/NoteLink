import { View } from 'react-native';
import { Text } from '@/components/text';
import Animated, { FadeInUp, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { toast, useToast } from '@/stores/toast';
import { useAuth } from '@/stores/auth';
import { Alert } from './ui';

/** 전역 오버레이: 로그인 만료 안내 + 토스트 */
export function AppOverlays() {
  return (
    <>
      <ExpiredDialog />
      <Toast />
    </>
  );
}

/** 토큰 갱신까지 실패하면 다시 로그인하게 한다. 같은 계정으로 들어오면 풀던 퀴즈 · 설정을 이어 간다 (p.101, FR-67-01) */
function ExpiredDialog() {
  const expired = useAuth((s) => s.expired);
  return (
    <Alert
      open={expired}
      tone="sun"
      title="로그인이 만료됐어요"
      body={'보안을 위해 다시 로그인해 주세요.\n하던 작업은 그대로 이어 갈 수 있어요.'}
      primary="다시 로그인"
      onPrimary={async () => {
        try {
          await useAuth.getState().expire();
          router.replace('/(auth)/login');
        } catch {
          useAuth.getState().setExpired(true);
          toast('기기의 로그인 정보를 저장하지 못했어요. 다시 시도해 주세요');
        }
      }}
    />
  );
}

function Toast() {
  const msg = useToast((s) => s.msg);
  const insets = useSafeAreaInsets();
  if (!msg) return null;
  return (
    <View
      pointerEvents="none"
      className="absolute inset-x-6"
      style={{ bottom: insets.bottom + 90 }}
    >
      <Animated.View
        entering={FadeInUp.duration(180)}
        exiting={FadeOut}
        className="rounded-2xl bg-ink/90 px-4 py-3"
      >
        <Text className="text-center text-footnote font-medium text-white">{msg}</Text>
      </Animated.View>
    </View>
  );
}
