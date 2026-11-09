import { useState } from 'react';
import { ActivityIndicator, Linking, Pressable, View } from 'react-native';
import { Text } from '@/components/text';
import Animated, { FadeIn } from 'react-native-reanimated';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Check, Sparkles } from 'lucide-react-native';
import { ERROR_CODES, type LearnerType, type SocialProvider } from '@notelink/shared';
import { api, ApiError } from '@/lib/api';
import { getProviderToken, socialLoginReady } from '@/lib/social-auth';
import { clearAccountState } from '@/lib/account';
import {
  confirmError,
  emailError,
  looksLikeEmail,
  nicknameError,
  passwordError,
} from '@/lib/validation';
import { useQuizProgress } from '@/stores/quiz-progress';
import { useAuth } from '@/stores/auth';
import { toast } from '@/stores/toast';
import { Btn, Canvas, Chip, Header, Input, Label, Screen, Tap, Title, cx } from '@/components/ui';
import { GoogleLogo, KakaoLogo, NaverLogo } from '@/components/brand-logos';
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
    <Canvas cream>
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
            <View className="h-40 w-40 items-center justify-center rounded-full bg-white">
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
                className={cx('h-1.5 rounded-full', n === i ? 'w-5 bg-brand' : 'w-1.5 bg-sub/30')}
              />
            ))}
          </View>
        </View>
      </Screen>
    </Canvas>
  );
}

/** 로그인 · 가입이 끝난 뒤 공통 처리 */
function useFinishSignIn() {
  const qc = useQueryClient();
  return async (r: Awaited<ReturnType<typeof api.auth.socialLogin>>) => {
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
}

/** 간편 로그인 버튼: 회사마다 규격 바탕색과 로고 */
const SOCIAL = [
  ['kakao', '카카오로 시작하기', 'bg-kakao', 'text-ink', KakaoLogo],
  ['google', 'Google로 시작하기', 'bg-white', 'text-ink', GoogleLogo],
  ['naver', '네이버로 시작하기', 'bg-naver', 'text-white', NaverLogo],
] as const;

/** 카카오 · Google · 네이버 간편 로그인 버튼. 처음 쓰는 계정은 서버가 만들고 초기 설정으로 이어진다 */
function SocialButtons() {
  const done = useFinishSignIn();
  const social = useMutation({
    mutationFn: async (p: SocialProvider) => api.auth.socialLogin(p, await getProviderToken(p)),
    onSuccess: done,
    onError: (e) => toast(e instanceof Error ? e.message : '로그인하지 못했어요'),
  });
  return (
    <View className="gap-3">
      {SOCIAL.map(([p, label, bg, fg, Logo]) => {
        const busy = social.isPending && social.variables === p;
        return (
          <Tap
            key={p}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled: !socialLoginReady || social.isPending }}
            disabled={!socialLoginReady || social.isPending}
            onPress={() => social.mutate(p)}
            className={cx(
              'h-control-lg flex-row items-center justify-center rounded-2xl px-5',
              bg,
              !socialLoginReady && 'opacity-50',
            )}
          >
            {/* 로고는 왼쪽 끝에 두고 글자는 가운데 */}
            <View className="absolute left-5">
              {busy ? <ActivityIndicator size="small" color={C.sub} /> : <Logo />}
            </View>
            <Text className={cx('text-callout font-semibold', fg)}>{label}</Text>
          </Tap>
        );
      })}
      {!socialLoginReady && (
        <Text className="text-center text-caption text-sub">
          간편 로그인은 준비 중이에요. 이메일로 시작해 주세요
        </Text>
      )}
    </View>
  );
}

/** 이메일 로그인과 간편 로그인 사이 구분선 */
const OrLine = ({ children }: { children: string }) => (
  <View className="my-8 flex-row items-center gap-3">
    <View className="h-px flex-1 bg-sub/20" />
    <Text className="text-caption text-sub">{children}</Text>
    <View className="h-px flex-1 bg-sub/20" />
  </View>
);

export function LoginScreen() {
  // 가입을 마치고 오면 가입한 이메일이 채워져 있다
  const { email: joined } = useLocalSearchParams<{ email?: string }>();
  const [email, setEmail] = useState(joined ?? '');
  const [pw, setPw] = useState('');
  const done = useFinishSignIn();
  const [loginError, setLoginError] = useState<string | null>(null);
  const byEmail = useMutation({
    mutationFn: () => api.auth.emailLogin(email.trim(), pw),
    onMutate: () => setLoginError(null),
    onSuccess: done,
    onError: (e) => setLoginError(e instanceof ApiError ? e.message : '로그인하지 못했어요'),
  });
  return (
    <Canvas cream>
      <Screen>
        <View className="items-center pt-16">
          <View className="h-16 w-16 items-center justify-center rounded-2xl bg-brand">
            <BookOpen size={30} color="#fff" />
          </View>
          <Text className="mt-4 text-title3 font-bold text-ink">노트링크</Text>
          <Text className="mt-1 text-caption text-sub">
            수기 대신 스마트하게, AI와 함께 배우는 노트 앱
          </Text>
        </View>

        {/* 1. 이메일 · 비밀번호 로그인이 맨 먼저 */}
        <View className="mt-8">
          <Label>이메일</Label>
          <Input
            value={email}
            onChangeText={(v) => {
              setEmail(v);
              setLoginError(null);
            }}
            placeholder="you@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
          />
          <Label>비밀번호</Label>
          <Input
            value={pw}
            onChangeText={(v) => {
              setPw(v);
              setLoginError(null);
            }}
            placeholder="8자 이상"
            secureTextEntry
            autoComplete="password"
          />
          {!!loginError && <Text className="mt-3 text-footnote text-danger">{loginError}</Text>}
          <Btn
            className="mt-6"
            disabled={!looksLikeEmail(email) || pw.length < 8}
            loading={byEmail.isPending}
            onPress={() => byEmail.mutate()}
          >
            로그인
          </Btn>
        </View>

        {/* 2. 그 아래 간편 로그인 */}
        <OrLine>간편 로그인</OrLine>
        <SocialButtons />

        {/* 3. 맨 아래 회원가입 */}
        <Pressable
          accessibilityRole="button"
          className="mt-8 self-center py-3"
          onPress={() => router.push('/(auth)/signup')}
        >
          <Text className="text-footnote text-sub">
            계정이 없나요? <Text className="font-semibold text-brand">회원가입</Text>
          </Text>
        </Pressable>
      </Screen>
    </Canvas>
  );
}

/** 칸 아래 안내 (없으면 그리지 않는다) */
const FieldError = ({ msg }: { msg: string | null }) =>
  msg ? <Text className="mt-1.5 text-caption text-danger">{msg}</Text> : null;

type SignupField = 'email' | 'pw' | 'confirm';

/** 가입 인증번호: 숫자 6자리 */
const CODE = /^\d{6}$/;

/**
 * 이메일 가입. 서버 계약대로 세 단계를 한 화면에서 잇는다:
 * ① 인증번호 받기(send-code) → ② 인증번호 확인으로 가입 증표 받기(verify-code) → ③ 증표 + 비밀번호로 가입(signup).
 * 인증번호를 보낸 뒤 이메일을 고치면 처음 단계로 돌아간다(증표는 보낸 이메일에만 맞다)
 */
export function SignupScreen() {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [taken, setTaken] = useState(false);
  // 인증번호를 보낸 이메일(보내기 전 null) · 입력한 인증번호 · 인증번호 칸 안내
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codeMsg, setCodeMsg] = useState<string | null>(null);
  // 안내는 칸을 벗어나거나 버튼을 누른 뒤부터 보여 준다 (쓰는 중인 칸을 탓하지 않는다)
  const [touched, setTouched] = useState<Record<SignupField, boolean>>({
    email: false,
    pw: false,
    confirm: false,
  });
  const touch = (f: SignupField) => () => setTouched((t) => ({ ...t, [f]: true }));
  const errors = {
    email: emailError(email),
    pw: passwordError(pw),
    confirm: confirmError(pw, confirm),
  };
  const shown = (f: SignupField) => (touched[f] ? errors[f] : null);
  // 확인 칸은 마지막 칸이라 벗어나지 않고 버튼을 누르기 쉽다 — 다 쓴 만큼 입력하면 바로 비교한다
  const confirmShown =
    shown('confirm') ?? (confirm.length >= pw.length && confirm ? errors.confirm : null);
  const formOk = () => {
    setTouched({ email: true, pw: true, confirm: true });
    return !errors.email && !errors.pw && !errors.confirm;
  };
  const toLogin = () =>
    router.replace({ pathname: '/(auth)/login', params: { email: email.trim() } });
  const failed = (e: unknown, fallback: string) =>
    toast(e instanceof ApiError ? e.message : fallback);
  const send = useMutation({
    mutationFn: (to: string) => api.auth.emailSendCode(to),
    onSuccess: (_, to) => {
      setSentTo(to);
      setCode('');
      setCodeMsg(null);
      toast('인증번호를 보냈어요. 메일을 확인해 주세요');
    },
    onError: (e) => failed(e, '인증번호를 보내지 못했어요. 다시 시도해 주세요'),
  });
  const signup = useMutation({
    mutationFn: async () => {
      const { verificationToken } = await api.auth.emailVerifyCode(sentTo!, code);
      await api.auth.emailSignup(verificationToken, pw);
    },
    onSuccess: () => {
      toast('가입했어요. 로그인해 주세요');
      toLogin();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === ERROR_CODES.EMAIL_TAKEN) setTaken(true);
      else if (e instanceof ApiError && e.code === ERROR_CODES.EMAIL_CODE_INVALID)
        setCodeMsg(e.message);
      else if (e instanceof ApiError && e.code === ERROR_CODES.EMAIL_CODE_LOCKED) {
        // 이 인증번호는 더 쓸 수 없다 — 새로 받게 처음 단계로
        setSentTo(null);
        toast(e.message);
      } else failed(e, '가입하지 못했어요. 다시 시도해 주세요');
    },
  });
  const sendCode = () => {
    if (formOk()) send.mutate(email.trim());
  };
  const submit = () => {
    if (!formOk()) return;
    if (!CODE.test(code)) return setCodeMsg('인증번호 6자리를 입력해 주세요');
    setCodeMsg(null);
    signup.mutate();
  };
  return (
    <Canvas cream>
      <Screen
        footer={
          sentTo ? (
            <Btn loading={signup.isPending} onPress={submit}>
              가입하기
            </Btn>
          ) : (
            <Btn loading={send.isPending} onPress={sendCode}>
              인증번호 받기
            </Btn>
          )
        }
      >
        <Header title="회원가입" sub="아이디로 쓸 이메일과 비밀번호를 정해 주세요" />
        <Label>이메일 (아이디)</Label>
        <Input
          value={email}
          onChangeText={(v) => {
            setEmail(v);
            setTaken(false);
            // 보낸 이메일과 달라지면 그 인증번호는 맞지 않는다
            if (sentTo !== null && v.trim() !== sentTo) setSentTo(null);
          }}
          onBlur={touch('email')}
          invalid={!!shown('email')}
          placeholder="you@example.com"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          maxLength={254}
        />
        <FieldError msg={shown('email')} />
        <Label>비밀번호</Label>
        <Input
          value={pw}
          onChangeText={setPw}
          onBlur={touch('pw')}
          invalid={!!shown('pw')}
          placeholder="영문 · 숫자 포함 8자 이상"
          secureTextEntry
          autoCapitalize="none"
          autoComplete="new-password"
          maxLength={64}
        />
        <FieldError msg={shown('pw')} />
        <Label>비밀번호 확인</Label>
        <Input
          value={confirm}
          onChangeText={setConfirm}
          onBlur={touch('confirm')}
          invalid={!!confirmShown}
          placeholder="한 번 더 입력해 주세요"
          secureTextEntry
          autoCapitalize="none"
          autoComplete="new-password"
          maxLength={64}
        />
        <FieldError msg={confirmShown} />
        {sentTo && (
          <>
            <Label>인증번호</Label>
            <Input
              value={code}
              onChangeText={(v) => {
                setCode(v.replace(/\D/g, ''));
                setCodeMsg(null);
              }}
              invalid={!!codeMsg}
              placeholder="메일로 받은 숫자 6자리"
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              maxLength={6}
            />
            <FieldError msg={codeMsg} />
            <Pressable
              accessibilityRole="button"
              disabled={send.isPending}
              onPress={() => send.mutate(sentTo)}
              className="mt-2 self-start"
            >
              <Text className="text-footnote font-semibold text-brand">인증번호 다시 받기</Text>
            </Pressable>
          </>
        )}
        {taken && (
          <View className="mt-3 flex-row items-center gap-2">
            <Text className="text-footnote text-danger">이미 가입한 이메일이에요</Text>
            <Pressable accessibilityRole="button" onPress={toLogin}>
              <Text className="text-footnote font-semibold text-brand">로그인하기</Text>
            </Pressable>
          </View>
        )}
        <Text className="mt-8 mb-3 text-center text-caption text-sub">또는 간편하게 시작</Text>
        <SocialButtons />
      </Screen>
    </Canvas>
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
    <Canvas cream>
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
              <View key={k} className="flex-row items-center rounded-2xl bg-white pr-2">
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
    </Canvas>
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
  const [type, setType] = useState<LearnerType | null>(null);
  const [interests, setInterests] = useState<string[]>([]);
  const save = useMutation({
    mutationFn: () =>
      api.me.update({ nickname: nick.trim(), learnerType: type!, interestCategoryIds: interests }),
    onSuccess: async (u) => {
      qc.setQueryData(['me'], u);
      await useAuth.getState().finishOnboarding();
      router.replace('/');
    },
  });
  const [tried, setTried] = useState(false);
  const nickErr = nicknameError(nick);
  // 닉네임은 쓰기 시작하면 바로, 학습자 유형은 시작하기를 누른 뒤에 안내한다
  const nickShown = nick || tried ? nickErr : null;
  const start = () => {
    setTried(true);
    if (!nickErr && type) save.mutate();
  };
  return (
    <Canvas cream>
      <Screen
        footer={
          <Btn loading={save.isPending} onPress={start}>
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
          invalid={!!nickShown}
          right={`${nick.length}/10`}
        />
        <FieldError msg={nickShown} />
        <Label>학습자 유형</Label>
        <View className="flex-row gap-2">
          {TYPES.map(([k, l]) => (
            <Chip key={k} on={type === k} onPress={() => setType(k)}>
              {l}
            </Chip>
          ))}
        </View>
        <FieldError msg={tried && !type ? '학습자 유형을 골라 주세요' : null} />
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
    </Canvas>
  );
}
