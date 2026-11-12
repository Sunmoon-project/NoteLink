import { Stack } from 'expo-router';

// 폴더 · 상세를 딥링크나 모달에서 바로 열어도 아래에 노트 목록을 깔아 둔다(뒤로 가기가 홈으로 새지 않게)
export const unstable_settings = { initialRouteName: 'index' };

export default function Layout() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#fff' } }} />
  );
}
