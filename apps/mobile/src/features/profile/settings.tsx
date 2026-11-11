import { useFeatureNavigation } from '@/lib/feature-navigation';
import { useEffect, useRef, useState } from 'react';
import { Linking, Pressable, ScrollView, View } from 'react-native';
import { Text } from '@/components/text';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarDays,
  Check,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  Gift,
  Zap,
} from 'lucide-react-native';
import type { PlanTier, UserSettings } from '@notelink/shared';
import { api } from '@/lib/api';
import { nicknameError } from '@/lib/validation';
import { env } from '@/lib/env';
import { clearAccountState } from '@/lib/account';
import { useAuth } from '@/stores/auth';
import { toast } from '@/stores/toast';
import { INTERESTS } from '../auth/auth';
import { LoadError } from '../progress/load-error';
import {
  Alert,
  Avatar,
  Badge,
  Btn,
  Canvas,
  Card,
  Chip,
  Group,
  Header,
  Input,
  Label,
  Loading,
  Progress,
  Row,
  Screen,
  Segment,
  Sheet,
  Title,
  Toggle,
  cx,
  Empty,
} from '@/components/ui';
import { C, ICON } from '@/theme';
import Constants from 'expo-constants';

// p.43~45 프로필 · 설정 · 계정 정보 · 닉네임 · 요금제

const LANGS = ['한국어', 'English', '日本語', '中文'];
const PAGE = { swipe: '좌우 스와이프', scroll: '위아래 스크롤', tap: '탭해서 넘기기' } as const;
const gb = (b: number) =>
  b >= 1024 ** 3 ? `${Math.round(b / 1024 ** 3)}GB` : b ? `${Math.round(b / 1024 ** 2)}MB` : '0KB';

/** 앱 버전은 app.config.ts의 version을 읽는다 */
const APP_VERSION = Constants.expoConfig?.version ?? '-';
export function SettingsScreen() {
  const openFeature = useFeatureNavigation();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me.get });
  const [sheet, setSheet] = useState<null | 'lang' | 'page' | 'help' | 'biz'>(null);
  const [dlg, setDlg] = useState<null | 'logout' | 'withdraw'>(null);
  const scroll = useRef<ScrollView>(null);
  const { scrollTo } = useLocalSearchParams<{ scrollTo?: string }>();
  useEffect(() => {
    if (scrollTo)
      setTimeout(() => scroll.current?.scrollTo({ y: scrollTo === 'rec' ? 460 : 900 }), 300);
  }, [scrollTo]);

  const update = useMutation({
    mutationFn: (s: Partial<UserSettings>) => api.me.update({ settings: s }),
    onMutate: (s) =>
      qc.setQueryData(['me'], (u: typeof me.data) =>
        u ? { ...u, settings: { ...u.settings, ...s } } : u,
      ),
    onError: () => toast('설정을 저장하지 못했어요. 다시 시도해 주세요'),
    onSettled: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
  const signOut = async (withdraw: boolean) => {
    let failure = '회원 탈퇴를 완료하지 못했어요. 다시 시도해 주세요';
    try {
      if (withdraw) await api.me.withdraw();
      else await api.auth.logout().catch(() => {});
      failure = '기기의 로그인 정보를 지우지 못했어요. 다시 시도해 주세요';
      await useAuth.getState().signOut();
      clearAccountState(qc);
      router.replace('/(auth)/login');
    } catch {
      toast(failure);
    }
  };
  // 내 정보를 못 불러와도 다시 시도 · 로그아웃은 할 수 있게 한다
  if (me.isError && !me.data)
    return (
      <Canvas>
        <Screen>
          <Title>설정</Title>
          <Empty
            icon={<CircleAlert size={32} color={C.danger} />}
            title="내 정보를 불러오지 못했어요"
          >
            <Btn onPress={() => me.refetch()}>다시 시도</Btn>
            <Btn kind="cream" className="mt-2" onPress={() => signOut(false)}>
              로그아웃
            </Btn>
          </Empty>
        </Screen>
      </Canvas>
    );
  if (!me.data) return <Loading />;
  const u = me.data;
  const s = u.settings;
  const set = (k: keyof UserSettings) => (v: boolean) => update.mutate({ [k]: v });
  const tier = { free: 'Free', pro: 'Pro', max: 'MAX' }[u.subscription?.tier ?? 'free'];
  return (
    <Canvas>
      <Screen scrollRef={scroll}>
        <Title>설정</Title>
        {/* 프로필: 큰 아바타와 이름이 맨 위. 누르면 계정 정보 */}
        <View className="flex-row items-center gap-4 py-3">
          <Pressable
            accessibilityLabel="프로필 사진 변경"
            onPress={() => openFeature('/(tabs)/profile/photo')}
          >
            <Avatar name={u.nickname} uri={u.avatarUrl} size={64} />
          </Pressable>
          <Pressable
            className="flex-1 flex-row items-center"
            onPress={() => router.push('/(tabs)/profile/account')}
          >
            <View className="flex-1">
              <Text className="text-title3 font-bold text-ink">{u.nickname}</Text>
              <Text className="text-caption text-sub">
                {u.school?.replace('등학교', '')} {u.grade} · {u.email}
              </Text>
            </View>
            <ChevronRight size={ICON.md} color={C.sub} />
          </Pressable>
        </View>

        <Label>내 계정</Label>
        <Group>
          <Row
            icon={Zap}
            chevron
            sub="더 많은 기능을 사용해보세요"
            onPress={() => router.push('/(tabs)/profile/plan')}
          >
            {`${tier} 플랜`}
          </Row>
        </Group>
        {/* 쓰는 양은 구획으로 — 눌러서 하는 일이 없어 카드로 감싸지 않는다 */}
        <View className="mt-5 px-1">
          <View className="flex-row justify-between">
            <Text className="text-caption text-sub">저장 공간</Text>
            <Text className="text-caption text-sub">
              {gb(u.usage?.storageBytes ?? 0)} / {gb(u.usage?.storageLimitBytes ?? 0)}
            </Text>
          </View>
          <Progress
            value={Math.max(
              2,
              ((u.usage?.storageBytes ?? 0) / (u.usage?.storageLimitBytes || 1)) * 100,
            )}
            className="mt-1.5"
          />
          <View className="mt-4 flex-row justify-between">
            <Text className="text-caption text-sub">AI 크레딧</Text>
            <Text className="text-caption text-sub">
              {u.usage?.aiCredits ?? 0}
              {u.usage?.aiCreditLimit ? ` / ${u.usage.aiCreditLimit}` : ''}
            </Text>
          </View>
          <Progress
            value={
              u.usage?.aiCreditLimit
                ? Math.max(2, ((u.usage.aiCredits ?? 0) / u.usage.aiCreditLimit) * 100)
                : 0
            }
            className="mt-1.5"
          />
        </View>

        <Label>학습</Label>
        <Group>
          <Row icon={CalendarDays} chevron onPress={() => openFeature('/record')}>
            캘린더 바로가기
          </Row>
        </Group>
        <Label>상점</Label>
        <Group>
          <Row icon={Gift} chevron onPress={() => openFeature('/shop')}>
            상점 바로가기
          </Row>
        </Group>
        <Label>녹음·재생</Label>
        <Group>
          <Row
            right={
              <Toggle label="이어듣기" on={s.resumePlayback} onChange={set('resumePlayback')} />
            }
          >
            이어듣기
          </Row>
          <Row
            right={
              <Toggle
                label="녹음 중 화면 켜 두기"
                on={s.keepScreenOnWhileRecording}
                onChange={set('keepScreenOnWhileRecording')}
              />
            }
          >
            녹음 중 화면 켜 두기
          </Row>
          <Row
            onPress={() => setSheet('lang')}
            right={
              <View className="rounded-full bg-fill px-3 py-1">
                <Text className="text-caption text-sub">{s.subtitleLanguage} ›</Text>
              </View>
            }
          >
            자막 기본 언어
          </Row>
        </Group>
        <Label>노트</Label>
        <Group>
          <Row
            onPress={() => setSheet('page')}
            right={<Text className="text-footnote text-sub">{PAGE[s.pageTurn]} ›</Text>}
          >
            페이지 넘김 방식
          </Row>
        </Group>
        <Label>데이터</Label>
        <Group>
          <Row
            right={
              <Toggle label="오프라인 캐시" on={s.offlineCache} onChange={set('offlineCache')} />
            }
          >
            오프라인 캐시
          </Row>
        </Group>
        <Label>테마</Label>
        <Segment
          items={['라이트', '다크'] as const}
          value={s.theme === 'dark' ? '다크' : '라이트'}
          onChange={(v) => {
            update.mutate({ theme: v === '다크' ? 'dark' : 'light' });
            if (v === '다크') toast('다크 테마는 준비 중이에요 · 설정은 저장했어요');
          }}
        />
        <Label>필기</Label>
        <Group>
          <Row
            right={
              <Toggle
                label="더블 탭으로 지우개 전환"
                on={s.doubleTapEraser}
                onChange={set('doubleTapEraser')}
              />
            }
          >
            더블 탭으로 지우개 전환
          </Row>
          <Row
            right={<Toggle label="왼손잡이 모드" on={s.leftHanded} onChange={set('leftHanded')} />}
          >
            왼손잡이 모드
          </Row>
        </Group>
        <Label>정보</Label>
        <Group>
          <Row chevron onPress={() => setSheet('help')}>
            도움말 및 지원
          </Row>
          <Row
            onPress={() => Linking.openURL('https://notelink.app/terms')}
            right={<ExternalLink size={ICON.sm} color={C.sub} />}
          >
            서비스 이용약관
          </Row>
          <Row
            onPress={() => Linking.openURL('https://notelink.app/privacy')}
            right={<ExternalLink size={ICON.sm} color={C.sub} />}
          >
            개인정보처리방침
          </Row>
          <Row chevron onPress={() => setSheet('biz')}>
            사업자 정보
          </Row>
          <Row right={<Text className="text-footnote text-sub">{APP_VERSION}</Text>}>앱 버전</Row>
        </Group>
        <Btn kind="cream" className="mt-6" onPress={() => setDlg('logout')}>
          로그아웃
        </Btn>
        <Pressable
          className="mt-3 self-center rounded-full px-3 py-1"
          onPress={() => setDlg('withdraw')}
        >
          <Text className="text-footnote text-danger">회원 탈퇴</Text>
        </Pressable>
      </Screen>

      <Sheet open={sheet === 'lang'} onClose={() => setSheet(null)} title="자막 기본 언어">
        <Group>
          {LANGS.map((l) => (
            <Row
              key={l}
              onPress={() => {
                update.mutate({ subtitleLanguage: l });
                setSheet(null);
              }}
              right={s.subtitleLanguage === l && <Check size={ICON.md} color={C.brand} />}
            >
              {l}
            </Row>
          ))}
        </Group>
      </Sheet>
      <Sheet open={sheet === 'page'} onClose={() => setSheet(null)} title="페이지 넘김 방식">
        <Group>
          {(Object.keys(PAGE) as (keyof typeof PAGE)[]).map((k) => (
            <Row
              key={k}
              onPress={() => {
                update.mutate({ pageTurn: k });
                setSheet(null);
              }}
              right={s.pageTurn === k && <Check size={ICON.md} color={C.brand} />}
            >
              {PAGE[k]}
            </Row>
          ))}
        </Group>
      </Sheet>
      <Sheet open={sheet === 'help'} onClose={() => setSheet(null)} title="도움말 및 지원">
        <Group>
          <Row chevron onPress={() => Linking.openURL('https://notelink.app/faq')}>
            자주 묻는 질문
          </Row>
          <Row
            chevron
            onPress={() => Linking.openURL('mailto:help@notelink.app?subject=노트링크 문의')}
          >
            1:1 문의하기
          </Row>
          <Row chevron onPress={() => Linking.openURL('https://notelink.app/guide')}>
            노트링크 사용 가이드
          </Row>
        </Group>
      </Sheet>
      <Sheet open={sheet === 'biz'} onClose={() => setSheet(null)} title="사업자 정보">
        <View className="gap-2 rounded-2xl bg-fill p-4">
          {[
            '상호 · 노트링크 (5조)',
            '대표 · 노트링크 팀',
            '주소 · 충청남도 아산시 탕정면 선문로 221번길 70',
            '문의 · help@notelink.app',
          ].map((t) => (
            <Text key={t} className="text-footnote text-ink/80">
              {t}
            </Text>
          ))}
        </View>
      </Sheet>
      <Alert
        open={dlg === 'logout'}
        tone="brand"
        icon="↪"
        title="로그아웃할까요?"
        body="기기에 저장된 노트는 그대로 남아 있어요."
        secondary="취소"
        onSecondary={() => setDlg(null)}
        primary="로그아웃"
        onPrimary={() => {
          setDlg(null);
          signOut(false);
        }}
      />
      <Alert
        open={dlg === 'withdraw'}
        title="정말 탈퇴할까요?"
        body="노트, 퀴즈, 포인트가 모두 삭제되고 복구할 수 없어요."
        secondary="취소"
        onSecondary={() => setDlg(null)}
        primary="탈퇴하기"
        onPrimary={() => {
          setDlg(null);
          signOut(true);
        }}
      />
    </Canvas>
  );
}

export function AccountScreen() {
  const openFeature = useFeatureNavigation();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me.get });
  const u = me.data;
  const rows: [string, string | undefined, (() => void) | null][] = [
    ['닉네임', u?.nickname, () => router.push('/(tabs)/profile/nickname')],
    [
      '관심 분야',
      u?.interestCategoryIds?.length ? u.interestCategoryIds.join(' · ') : '선택 안 함',
      () => router.push('/(tabs)/profile/interests'),
    ],
    ['이메일', u?.email ?? undefined, null],
    ['전화번호', u?.phone, null],
    ['학교', u?.school, null],
    ['학년', u?.grade, null],
  ];
  return (
    <Canvas>
      <Screen>
        <Header title="계정 정보" />
        <Card
          onPress={() => openFeature('/(tabs)/profile/avatar-style')}
          className="flex-row items-center px-5 py-4"
        >
          <View className="flex-1">
            <Text className="text-caption2 text-sub">아바타</Text>
            <Text className="text-callout text-ink">아바타 설정하기</Text>
          </View>
          <ChevronRight size={ICON.md} color={C.sub} />
        </Card>
        <View className="mt-4 overflow-hidden rounded-card bg-white">
          {rows.map(([k, v, go], i) => (
            <Pressable
              key={k}
              onPress={go ?? (() => toast(`${k} 변경은 본인 인증 후 가능해요`))}
              className={cx('flex-row items-center px-5 py-4', i > 0 && 'border-t border-fill')}
            >
              <View className="flex-1">
                <Text className="text-caption2 text-sub">{k}</Text>
                <Text className="text-callout text-ink">{v}</Text>
              </View>
              <ChevronRight size={ICON.md} color={C.sub} />
            </Pressable>
          ))}
        </View>
      </Screen>
    </Canvas>
  );
}

export function NicknameScreen() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me.get });
  const [v, setV] = useState(me.data?.nickname ?? '');
  const err = nicknameError(v);
  const ok = !err;
  const save = useMutation({
    mutationFn: () => api.me.update({ nickname: v.trim() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['me'] });
      router.back();
      toast('닉네임을 바꿨어요');
    },
  });
  return (
    <Canvas>
      <Screen
        footer={
          <Btn disabled={!ok} loading={save.isPending} onPress={() => save.mutate()}>
            저장
          </Btn>
        }
      >
        <Header title="닉네임 변경" />
        <Label>닉네임</Label>
        <Input
          value={v}
          onChangeText={(x) => setV(x.slice(0, 10))}
          autoFocus
          invalid={!ok && !!v}
        />
        <View className="mt-2 flex-row justify-between">
          <Text className={cx('text-caption', !ok ? 'text-danger' : 'text-sub')}>
            {err ?? '한글 · 영문 · 숫자 2~10자'}
          </Text>
          <Text className="text-caption text-sub">{v.length}/10</Text>
        </View>
      </Screen>
    </Canvas>
  );
}

/** 관심 분야 다시 고르기(프로필 > 계정 정보). 온보딩과 같은 칩, 여러 개 고를 수 있고 비워 둬도 된다 */
export function InterestsScreen() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me.get });
  const saved = me.data?.interestCategoryIds ?? [];
  // 건드리기 전에는 저장된 값을 보여 준다(돌아와 다시 읽혀도 고르던 것이 덮이지 않게, 고른 뒤에는 내 값)
  const [picked, setPicked] = useState<string[] | null>(null);
  const now = picked ?? saved;
  const changed = now.length !== saved.length || now.some((x) => !saved.includes(x));
  const toggle = (x: string) =>
    setPicked(now.includes(x) ? now.filter((y) => y !== x) : [...now, x]);
  // 저장 응답이 늦게 와도 화면을 떠났으면 뒤로 가지 않고, 계정이 바뀌었으면 지금 계정 캐시에 넣지 않는다
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const save = useMutation({
    mutationFn: async () => {
      const who = useAuth.getState().userId;
      return { who, u: await api.me.update({ interestCategoryIds: now }) };
    },
    onSuccess: ({ who, u }) => {
      if (useAuth.getState().userId !== who) return;
      qc.setQueryData(['me'], u);
      if (!alive.current) return;
      router.back();
      toast('관심 분야를 바꿨어요');
    },
  });
  if (me.isPending) return <Loading />;
  // 못 읽었으면 빈 목록으로 열어 저장된 관심 분야를 덮어쓰지 않게 다시 읽게 한다
  if (!me.data)
    return (
      <Canvas>
        <Screen>
          <Header title="관심 분야" large={false} />
          <LoadError message="관심 분야를 불러오지 못했어요" retry={() => me.refetch()} />
        </Screen>
      </Canvas>
    );
  return (
    <Canvas>
      <Screen
        footer={
          <Btn disabled={!changed} loading={save.isPending} onPress={() => save.mutate()}>
            저장
          </Btn>
        }
      >
        <Header title="관심 분야" sub="공부하고 있는 분야를 골라 주세요. 여러 개 골라도 돼요" />
        <View className="mt-2 flex-row flex-wrap gap-2">
          {INTERESTS.map((x) => (
            <Chip key={x} on={now.includes(x)} onPress={() => toggle(x)}>
              {x}
            </Chip>
          ))}
        </View>
        <Text className="mt-4 text-caption text-sub">
          {now.length ? `${now.length}개 골랐어요` : '고르지 않아도 괜찮아요'}
        </Text>
      </Screen>
    </Canvas>
  );
}

const PLANS: { id: PlanTier; name: string; price: string; desc: string[]; hot?: boolean }[] = [
  {
    id: 'free',
    name: 'Free',
    price: '0원 / 월',
    desc: ['녹음 3시간/월 · AI 요약 10회/월', '저장공간 2GB'],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '4,900원 / 월',
    desc: ['녹음 무제한 · AI 요약 무제한', '저장공간 50GB · 퀴즈 무제한 생성'],
    hot: true,
  },
  {
    id: 'max',
    name: 'MAX',
    price: '9,900원 / 월',
    desc: ['Pro의 모든 기능 포함', '스터디룸 무제한 · 저장공간 200GB · 우선 지원'],
  },
];

/** 결제 연동 전: 무료 플랜으로만 바꿀 수 있다 (기기 저장 모드는 화면 확인용으로 모두 허용) */
export const canChangePlan = (t: PlanTier) => t === 'free' || env.localData;

export function PlanScreen() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me.get });
  const cur = me.data?.subscription?.tier ?? 'free';
  const [pick, setPick] = useState<PlanTier | null>(null);
  // 결제는 README 결정 사항대로 나중에 붙인다 — 그전까지 실서버에서는 유료 플랜으로 바꾸지 않는다
  const change = useMutation({
    mutationFn: (t: PlanTier) => api.me.changePlan(t),
    onSuccess: (u) => {
      qc.setQueryData(['me'], u);
      setPick(null);
      toast('플랜이 적용됐어요');
    },
  });
  return (
    <Canvas>
      <Screen>
        <Header title="요금제" sub="나에게 맞는 플랜을 선택하세요" />
        <View className="gap-4">
          {PLANS.map((p) => (
            <Card key={p.id} className="p-6">
              <View className="flex-row items-center justify-between">
                <Text className="text-headline font-bold text-ink">{p.name}</Text>
                {p.hot && <Badge tone="dark">인기</Badge>}
              </View>
              <Text
                className={cx(
                  'mt-1 text-callout font-semibold',
                  p.id === 'free' ? 'text-sub' : 'text-brand',
                )}
              >
                {p.price}
              </Text>
              {p.desc.map((d) => (
                <Text key={d} className="text-caption text-sub">
                  {d}
                </Text>
              ))}
              <Btn
                small
                className="mt-3"
                kind={cur === p.id ? 'outline' : p.id === 'max' ? 'dark' : 'primary'}
                disabled={cur === p.id}
                onPress={() =>
                  canChangePlan(p.id) ? setPick(p.id) : toast('결제는 준비 중이에요. 곧 열려요')
                }
              >
                {cur === p.id
                  ? '현재 플랜'
                  : p.id === 'free'
                    ? 'Free로 변경'
                    : `${p.name}로 업그레이드`}
              </Btn>
            </Card>
          ))}
        </View>
        <Alert
          open={!!pick}
          tone="brand"
          icon={<Zap size={ICON.lg} color={C.brand} />}
          title={`${PLANS.find((p) => p.id === pick)?.name} 플랜으로 바꿀까요?`}
          body="결제는 앱 마켓 계정으로 진행돼요. 언제든 해지할 수 있어요."
          secondary="취소"
          onSecondary={() => setPick(null)}
          primary="변경하기"
          onPrimary={() => pick && change.mutate(pick)}
        />
      </Screen>
    </Canvas>
  );
}
