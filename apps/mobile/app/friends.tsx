import { router } from 'expo-router';
import { SocialDrawer } from '@/features/social/drawer';

// 투명 모달 옵션(DRAWER_SCREEN)은 app/_layout의 루트 스택에서 준다
export default function FriendsRoute() {
  return <SocialDrawer open onClose={() => router.back()} />;
}
