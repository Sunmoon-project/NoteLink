import { View } from 'react-native';
import { Redirect, Tabs } from 'expo-router';
import { BookOpen, Home, NotebookPen, User, Users, type LucideIcon } from 'lucide-react-native';
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
        tabBarInactiveTintColor: '#a3a8ae',
        tabBarStyle: { borderTopColor: C.line },
        tabBarLabelStyle: { fontSize: 10, fontWeight: '500' },
      }}
    >
      {TABS.map(([name, title, Icon]) => (
        <Tabs.Screen
          key={name}
          name={name}
          options={{
            title,
            tabBarIcon: ({ focused }) => (
              <View
                className="h-7 w-7 items-center justify-center rounded-lg"
                style={{ backgroundColor: focused ? C.brand : '#e6e8eb' }}
              >
                <Icon size={ICON.sm} color={focused ? '#fff' : '#a3a8ae'} />
              </View>
            ),
          }}
        />
      ))}
    </Tabs>
  );
}
