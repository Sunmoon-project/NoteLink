import { useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { Text } from '@/components/text';
import Animated, { FadeIn } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Check, Sparkles } from 'lucide-react-native';
import type { LearnerType, SocialProvider } from '@notelink/shared';
import { api, ApiError } from '@/lib/api';
import { getProviderToken, socialLoginReady } from '@/lib/social-auth';
import { clearAccountState } from '@/lib/account';
import { useQuizProgress } from '@/stores/quiz-progress';
import { useAuth } from '@/stores/auth';
import { toast } from '@/stores/toast';
import { Btn, Chip, Input, Label, Screen, Sheet, Title, cx } from '@/components/ui';
import { C, ICON } from '@/theme';

// p.104 가입부터 홈까지 — 온보딩 · 로그인 · 약관 동의 · 프로필 설정 (스플래시는 네이티브 스플래시 화면)

const SLIDES = [
  ['AI가 필기와 녹음을\n정리해 줘요', '사진 한 장, 녹음 하나로 요약 노트가 만들어져요'],
  ['노트가 바로\n퀴즈가 돼요', '틀린 문제는 AI가 설명하고 비슷한 문제로 복습해요'],
  ['친구와 함께\n순공시간을 쌓아요', '스터디룸에서 캠을 켜고 같이 집중해요'],
];

export function OnboardingScreen() {
  const [i, setI] = useState(0);
  return (
    <Screen
      footer={
        <Btn
          onPress={() => (i < SLIDES.length - 1 ? setI(i + 1) : router.replace('/(auth)/login'))}
        >
          {i < SLIDES.length - 1 ? '다음' : '시작하기'}
        </Btn>
      }
    >
      <View className="items-center pt-28">
        <Animated.View key={i} entering={FadeIn} className="items-center">
          <View className="h-40 w-40 items-center justify-center rounded-full bg-mint">
            <Sparkles size={56} color={C.brand} />
          </View>
          <Text className="mt-10 text-center text-title3 font-bold leading-7 text-ink">
            {SLIDES[i]?.[0]}
          </Text>
          <Text className="mt-2 text-center text-footnote text-sub">{SLIDES[i]?.[1]}</Text>
        </Animated.View>
        <View className="mt-8 flex-row gap-1.5">
          {SLIDES.map((_, n) => (
            <View
              key={n}
              className={cx('h-1.5 rounded-full', n === i ? 'w-5 bg-brand' : 'w-1.5 bg-cream-2')}
            />
          ))}
        </View>
      </View>
    </Screen>
  );
}

export function LoginScreen() {
  const qc = useQueryClient();
  const [emailOpen, setEmailOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const done = async (r: Awaited<ReturnType<typeof api.auth.socialLogin>>) => {
    // 다른 계정으로 로그인하면 이전 계정의 캐시 · 소켓 연결을 버린다
    // (같은 계정의 만료 후 재로그인은 풀던 퀴즈를 이어 가도록 남긴다 — FR-67-01)
    const prev = useAuth.getState().userId;
    if (prev && prev !== r.user._id) clearAccountState(qc);
    await useAuth
      .getState()
      .signIn({ accessToken: r.accessToken, refreshToken: r.refreshToken }, r.user);
    qc.setQueryData(['me'], r.user);
    const progress = useQuizProgress.getState().progress;
    router.replace(
      useAuth.getState().onboarded
        ? prev === r.user._id && progress
          ? { pathname: '/play/solve', params: { setId: progress.setId } }
          : '/'
        : '/(auth)/terms',
    );
  };
  const social = useMutation({
    mutationFn: async (p: SocialProvider) => api.auth.socialLogin(p, await getProviderToken(p)),
    onSuccess: done,
    onError: (e) => toast(e instanceof Error ? e.message : '로그인하지 못했어요'),
  });
  const byEmail = useMutation({
    mutationFn: () => api.auth.emailLogin(email.trim(), pw),
    onSuccess: done,
    onError: (e) => toast(e instanceof ApiError ? e.message : '로그인하지 못했어요'),
  });
  return (
    <Screen>
      <View className="items-center pt-40">
        <View className="h-16 w-16 items-center justify-center rounded-2xl bg-brand">
          <BookOpen size={30} color="#fff" />
        </View>
        <Text className="mt-4 text-title3 font-bold text-ink">노트링크</Text>
        <Text className="mt-1 text-caption text-sub">
          수기 대신 스마트하게, AI와 함께 배우는 노트 앱
        </Text>
      </View>
      <View className="mt-24 gap-2.5">
        <Btn
          kind="sun"
          disabled={!socialLoginReady}
          loading={social.isPending && social.variables === 'kakao'}
          onPress={() => social.mutate('kakao')}
        >
          카카오로 시작하기
        </Btn>
        <Btn
          kind="outline"
          disabled={!socialLoginReady}
          loading={social.isPending && social.variables === 'naver'}
          onPress={() => social.mutate('naver')}
        >
          네이버로 시작하기
        </Btn>
        <Btn
          kind="outline"
          disabled={!socialLoginReady}
          loading={social.isPending && social.variables === 'google'}
          onPress={() => social.mutate('google')}
        >
          Google로 시작하기
        </Btn>
        <Btn onPress={() => setEmailOpen(true)}>이메일로 시작하기</Btn>
        {!socialLoginReady && (
          <Text className="text-center text-caption text-sub">
            소셜 로그인은 준비 중이에요. 이메일로 시작해 주세요
          </Text>
        )}
      </View>
      <Sheet open={emailOpen} onClose={() => setEmailOpen(false)} title="이메일로 시작하기">
        <Label>이메일</Label>
        <Input
          value={email}
          onChangeText={setEmail}
          placeholder="you@example.com"
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
        />
        <Label>비밀번호</Label>
        <Input
          value={pw}
          onChangeText={setPw}
          placeholder="8자 이상"
          secureTextEntry
          autoComplete="password"
        />
        <Btn
          className="mt-6"
          disabled={!/^\S+@\S+\.\S+$/.test(email) || pw.length < 8}
          loading={byEmail.isPending}
          onPress={() => byEmail.mutate()}
        >
          로그인
        </Btn>
      </Sheet>
    </Screen>
  );
}

const TERMS = [
  ['service', '이용약관 (필수)', true, 'https://notelink.app/terms'],
  ['privacy', '개인정보 처리 (필수)', true, 'https://notelink.app/privacy'],
  ['marketing', '마케팅 수신 (선택)', false, 'https://notelink.app/marketing'],
] as const;

const Box = ({ on }: { on: boolean }) => (
  <View
    className={cx(
      'h-6 w-6 items-center justify-center rounded-full',
      on ? 'bg-brand' : 'border border-cream-2',
    )}
  >
    {on && <Check size={ICON.xs} color="#fff" />}
  </View>
);

export function TermsScreen() {
  const [agreed, setAgreed] = useState<string[]>([]);
  const all = agreed.length === TERMS.length;
  const required = TERMS.filter((t) => t[2]).every((t) => agreed.includes(t[0]));
  const save = useMutation({
    mutationFn: () => api.auth.agreeTerms(agreed),
    onSuccess: () => router.replace('/(auth)/profile-setup'),
  });
  return (
    <Screen
      footer={
        <Btn disabled={!required} loading={save.isPending} onPress={() => save.mutate()}>
          동의하고 계속
        </Btn>
      }
    >
      <Title>약관 동의</Title>
      <Pressable
        onPress={() => setAgreed(all ? [] : TERMS.map((t) => t[0]))}
        className="flex-row items-center gap-3 rounded-2xl bg-mint px-4 py-4"
      >
        <Box on={all} />
        <Text className="text-callout font-bold text-ink">전체 동의</Text>
      </Pressable>
      <View className="mt-2 gap-2">
        {TERMS.map(([k, l, , url]) => {
          const on = agreed.includes(k);
          // 동의 체크와 '보기'(전문 열기)는 따로 누른다
          return (
            <View key={k} className="flex-row items-center rounded-2xl border border-line pr-2">
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                onPress={() => setAgreed((p) => (on ? p.filter((x) => x !== k) : [...p, k]))}
                className="flex-1 flex-row items-center gap-3 py-3.5 pl-4"
              >
                <Box on={on} />
                <Text className="flex-1 text-subhead text-ink">{l}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="link"
                accessibilityLabel={`${l} 전문 보기`}
                onPress={() => Linking.openURL(url)}
                className="px-2 py-3.5"
              >
                <Text className="text-caption text-sub">보기</Text>
              </Pressable>
            </View>
          );
        })}
      </View>
    </Screen>
  );
}

const TYPES: [LearnerType, string][] = [
  ['middle_high', '중·고등학생'],
  ['university', '대학생'],
  ['worker', '직장인'],
];
const INTERESTS = ['자격증', '수능', '어학', '전공', '코딩', '공무원'];

export function ProfileSetupScreen() {
  const qc = useQueryClient();
  const [nick, setNick] = useState('');
  const [type, setType] = useState<LearnerType>('university');
  const [interests, setInterests] = useState<string[]>(['자격증', '수능']);
  const save = useMutation({
    mutationFn: () =>
      api.me.update({ nickname: nick.trim(), learnerType: type, interestCategoryIds: interests }),
    onSuccess: async (u) => {
      qc.setQueryData(['me'], u);
      await useAuth.getState().finishOnboarding();
      router.replace('/');
    },
  });
  const ok = nick.trim().length >= 2 && nick.trim().length <= 10;
  return (
    <Screen
      footer={
        <Btn disabled={!ok} loading={save.isPending} onPress={() => save.mutate()}>
          시작하기
        </Btn>
      }
    >
      <Title>프로필 설정</Title>
      <Label>닉네임</Label>
      <Input
        value={nick}
        onChangeText={(v) => setNick(v.slice(0, 10))}
        placeholder="노트러버"
        autoFocus
        right={`${nick.length}/10`}
      />
      <Label>학습자 유형</Label>
      <View className="flex-row gap-2">
        {TYPES.map(([k, l]) => (
          <Chip key={k} on={type === k} onPress={() => setType(k)}>
            {l}
          </Chip>
        ))}
      </View>
      <Label>관심 분야</Label>
      <View className="flex-row flex-wrap gap-2">
        {INTERESTS.map((x) => (
          <Chip
            key={x}
            on={interests.includes(x)}
            onPress={() =>
              setInterests((p) => (p.includes(x) ? p.filter((y) => y !== x) : [...p, x]))
            }
          >
            {x}
          </Chip>
        ))}
      </View>
    </Screen>
  );
}
