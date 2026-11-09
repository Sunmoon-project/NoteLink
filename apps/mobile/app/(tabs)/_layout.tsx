import { Redirect, Tabs } from 'expo-router';
import { BookOpen, Home, NotebookPen, User, Users, type LucideIcon } from 'lucide-react-native';
import { useTourOnce } from '@/features/tutor/tour';
import { useAuth } from '@/stores/auth';
import { C, ICON } from '@/theme';

// 하단 탭 5개: 홈 · 노트 · 퀴즈 · 스터디룸 · 프로필 (세팅안 v2 6장)
const TABS: [string, string, LucideIcon][] = [
  ['(home)', '홈', Home],
  ['note', '노트', NotebookPen],
  ['quiz', '퀴즈', BookOpen],
  ['studyroom', '스터디룸', Users],
  ['profile', '프로필', User],
];

export default function TabsLayout() {
  const tokens = useAuth((s) => s.tokens);
  const onboarded = useAuth((s) => s.onboarded);
  // 가입을 마치고 처음 들어오면 아바타 선생님이 앱 사용법을 안내한다
  useTourOnce(!!tokens && onboarded);
  // 로그인 전이면 온보딩, 가입 절차가 남았으면 약관 동의로 (p.104)
  if (!tokens) return <Redirect href="/onboarding" />;
  if (!onboarded) return <Redirect href="/terms" />;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        // 탭을 바꾸면 화면이 살짝 밀리며 바뀐다
        animation: 'shift',
        tabBarActiveTintColor: C.brand,
        tabBarInactiveTintColor: C.sub,
        tabBarStyle: { backgroundColor: '#fff', borderTopColor: C.fill },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}
    >
      {TABS.map(([name, title, Icon]) => (
        <Tabs.Screen
          key={name}
          name={name}
          options={{
            title,
            // 색 칸 없이 아이콘만. 고른 탭은 브랜드색 · 굵은 선
            tabBarIcon: ({ focused, color }) => (
              <Icon size={ICON.lg} color={color} strokeWidth={focused ? 2.4 : 2} />
            ),
          }}
        />
      ))}
    </Tabs>
  );
}
