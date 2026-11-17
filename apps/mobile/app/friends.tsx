import { router, Stack } from 'expo-router';
import { SocialDrawer } from '@/features/social/drawer';

export default function FriendsRoute() {
  return (
    <>
      <Stack.Screen
        options={{
          presentation: 'transparentModal',
          animation: 'none',
          contentStyle: { backgroundColor: 'transparent' },
        }}
      />
      <SocialDrawer open onClose={() => router.back()} />
    </>
  );
}
