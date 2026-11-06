import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import { Text } from '@/components/text';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiJob } from '@notelink/shared';
import * as ImagePicker from 'expo-image-picker';
import { Camera, Check, ChevronRight, ImageIcon, Info } from 'lucide-react-native';
import { api } from '@/lib/api';
import { uploadToBlob, type LocalFile } from '@/lib/upload';
import { socket } from '@/lib/socket';
import { useSocket } from '@/hooks';
import { toast } from '@/stores/toast';
import { AV_STYLES } from '@/lib/avatar-styles';
import { useNet } from '@/stores/net';
import {
  Avatar,
  Badge,
  Btn,
  Card,
  Group,
  Header,
  Input,
  Label,
  Ring,
  Row,
  Screen,
  Segment,
  Sheet,
  cx,
} from '@/components/ui';
import { C, ICON } from '@/theme';
import { aiWaiting } from '@/lib/ai';
import { AiPending } from '@/components/AiPending';

// p.82 프로필 변경 (사진 → AI 서버 아바타 생성) / p.83 아바타 설정

/** p.82 #22 사진 촬영 또는 첨부 */
export function PhotoScreen() {
  const go = async (camera: boolean) => {
    const opts: ImagePicker.ImagePickerOptions = {
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
      cameraType: ImagePicker.CameraType.front,
    };
    if (camera) {
      const p = await ImagePicker.requestCameraPermissionsAsync();
      if (!p.granted) return toast('카메라 권한을 허용해 주세요');
    }
    const r = camera
      ? await ImagePicker.launchCameraAsync(opts)
      : await ImagePicker.launchImageLibraryAsync(opts);
    const asset = r.canceled ? undefined : r.assets[0];
    const uri = asset?.uri;
    if (asset && uri) {
      router.push({
        pathname: '/(tabs)/profile/photo-style',
        params: {
          uri,
          name: asset.fileName ?? uri.split('/').pop(),
          mimeType: asset.mimeType ?? undefined,
        },
      });
    }
  };
  return (
    <Screen>
      <Header title="프로필" sub="프로필을 만들어 보세요" />
      <View className="aspect-square items-center justify-center rounded-2xl bg-night">
        <Text className="absolute top-3 text-caption text-white/50">1/2</Text>
        <Camera size={40} color="rgba(255,255,255,.5)" />
      </View>
      <View className="mt-4 gap-2">
        <Card tone="mint" onPress={() => go(true)} className="flex-row items-center gap-3 p-4">
          <Camera size={ICON.md} color={C.brand} />
          <View className="flex-1">
            <Text className="text-subhead font-semibold text-ink">카메라로 프로필 만들기</Text>
            <Text className="text-caption text-sub">카메라로 바로 찍어서 프로필 만들기</Text>
          </View>
          <ChevronRight size={ICON.md} color={C.sub} />
        </Card>
        <Card tone="mint" onPress={() => go(false)} className="flex-row items-center gap-3 p-4">
          <ImageIcon size={ICON.md} color={C.brand} />
          <View className="flex-1">
            <Text className="text-subhead font-semibold text-ink">첨부사진으로 프로필 만들기</Text>
            <Text className="text-caption text-sub">첨부사진을 추가하여 프로필 만들기</Text>
          </View>
          <ChevronRight size={ICON.md} color={C.sub} />
        </Card>
      </View>
    </Screen>
  );
}

const STYLES = ['기본 일러스트', '3D 캐릭터', '수채화', '픽셀 아트'];

/** p.82 #23 프로필 형태 선택 */
export function PhotoStyleScreen() {
  const params = useLocalSearchParams<{ uri?: string; name?: string; mimeType?: string }>();
  const [file, setFile] = useState<LocalFile | undefined>(() =>
    params.uri
      ? {
          uri: params.uri,
          name: params.name ?? params.uri.split('/').pop() ?? 'profile.jpg',
          mimeType: params.mimeType,
        }
      : undefined,
  );
  const uri = file?.uri;
  const [prompt, setPrompt] = useState('');
  const [style, setStyle] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const gen = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('사진을 선택해 주세요');
      const blob = await uploadToBlob('image', file);
      return api.me.generateProfile({ photoBlobUrl: blob, prompt, style });
    },
    onSuccess: (job) =>
      router.replace({ pathname: '/(tabs)/profile/photo-gen', params: { jobId: job._id } }),
    onError: () => toast('사진을 올리지 못했어요. 다시 시도해 주세요'),
  });
  const pick = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    const picked = r.canceled ? undefined : r.assets[0];
    if (picked)
      setFile({
        uri: picked.uri,
        name: picked.fileName ?? picked.uri.split('/').pop() ?? 'profile.jpg',
        mimeType: picked.mimeType ?? undefined,
        size: picked.fileSize,
      });
  };
  return (
    <Screen
      footer={
        <Btn kind="cream" disabled={!uri} loading={gen.isPending} onPress={() => gen.mutate()}>
          프로필 생성하기 →
        </Btn>
      }
    >
      <Header title="프로필" sub="첨부 사진으로 프로필을 생성해 보세요" />
      <Card tone="night" onPress={pick} className="items-center p-6">
        {uri ? (
          <Image source={{ uri }} className="h-24 w-24 rounded-full" />
        ) : (
          <View className="h-14 w-14 items-center justify-center rounded-full bg-white/10">
            <Camera size={ICON.lg} color="#fff" />
          </View>
        )}
        <Text className="mt-3 text-subhead font-semibold text-white">
          {uri ? '사진이 준비됐어요' : '첨부 또는 카메라로 찍은 사진'}
        </Text>
        <Text className="text-caption text-white/60">
          {uri ? '눌러서 사진을 바꿀 수 있어요' : '얼굴이 선명하게 보이는 사진을 선택해 주세요'}
        </Text>
      </Card>
      <Input
        className="mt-3"
        value={prompt}
        onChangeText={setPrompt}
        placeholder='예) "친절한 학생 프로필을 만들어 주세요"'
      />
      <Label>생성 프롬프트</Label>
      <Card tone="mint" onPress={() => setOpen(true)} className="flex-row items-center p-4">
        <View className="flex-1">
          <Text className="text-subhead font-semibold text-ink">프로필 스타일 선택</Text>
          <Text className="text-caption text-sub">
            {style ?? '원하는 스타일을 추가하여 프로필 만들기'}
          </Text>
        </View>
        <ChevronRight size={ICON.md} color={C.sub} />
      </Card>
      <Card tone="white" className="mt-3 p-4">
        <View className="mb-1 flex-row items-center gap-1">
          <Info size={ICON.xs} color={C.ink} />
          <Text className="text-caption font-semibold text-ink">생성 안내</Text>
        </View>
        <Text className="text-caption text-sub">
          • 사진이 더 선명할수록 프로필 품질이 높아집니다
        </Text>
        <Text className="text-caption text-sub">
          • 프롬프트를 자세히 입력하면 원하는 스타일을 더 잘 반영합니다
        </Text>
      </Card>
      <Sheet open={open} onClose={() => setOpen(false)} title="프로필 스타일">
        <Group>
          {STYLES.map((x) => (
            <Row
              key={x}
              onPress={() => {
                setStyle(x);
                setOpen(false);
              }}
              right={style === x && <Check size={ICON.md} color={C.brand} />}
            >
              {x}
            </Row>
          ))}
        </Group>
      </Sheet>
    </Screen>
  );
}

/** p.82 #24 생성 로딩 — AI 서버 진행률을 소켓으로 받는다 */
export function PhotoGenScreen() {
  const { jobId } = useLocalSearchParams<{ jobId: string }>();
  const qc = useQueryClient();
  const [pct, setPct] = useState(0);
  const online = useNet((s) => s.state === 'ok');
  const handled = useRef(false);
  // 끝난 작업은 한 번만 처리한다 (소켓 완료 이벤트 · 상태 재조회 중 먼저 온 쪽)
  const finish = (status: AiJob['status']) => {
    if (handled.current || !['succeeded', 'failed', 'canceled'].includes(status)) return;
    handled.current = true;
    qc.invalidateQueries({ queryKey: ['me'] });
    router.dismissTo('/(tabs)/profile');
    toast(
      status === 'succeeded'
        ? '새 프로필이 적용됐어요'
        : '프로필을 만들지 못했어요. 다시 시도해 주세요',
    );
  };
  // 다시 연결되면 다시 구독한다
  useEffect(() => {
    if (online) socket.emit('ai:subscribe', { jobId });
  }, [jobId, online]);
  useSocket('ai:progress', (p) => p.jobId === jobId && setPct(p.progress), [jobId]);
  useSocket('ai:done', (p) => p.jobId === jobId && finish(p.job.status), [jobId]);
  // 끊긴 사이 완료 이벤트를 놓쳐도 작업 상태를 다시 물어 빠져나온다
  const job = useQuery({
    queryKey: ['ai-job', jobId],
    queryFn: () => api.ai.job(jobId),
    retry: false,
    refetchInterval: (query) =>
      query.state.error ||
      ['succeeded', 'failed', 'canceled'].includes(query.state.data?.status ?? '')
        ? false
        : 5000,
  });
  useEffect(() => {
    if (job.data) finish(job.data.status);
  }, [job.data?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  // AI 서버가 없으면 생성을 대기열에 두고 돌아간다 (FR-65-05)
  if (aiWaiting(job.data))
    return (
      <Screen
        footer={<Btn onPress={() => router.dismissTo('/(tabs)/profile')}>프로필로 돌아가기</Btn>}
      >
        <Header title="프로필 생성" back={false} />
        <View className="pt-10">
          <AiPending
            what="프로필 이미지 생성"
            hint="사진은 저장했어요. AI 서버가 연결되면 고른 스타일로 만들어져요."
          />
        </View>
      </Screen>
    );
  return (
    <Screen>
      <Header title="프로필 생성" back={false} />
      {job.isError && (
        <View className="gap-3 py-4">
          <Text>작업 상태를 확인하지 못했어요</Text>
          <Btn onPress={() => job.refetch()}>다시 시도</Btn>
          <Btn kind="outline" onPress={() => router.dismissTo('/(tabs)/profile')}>
            돌아가기
          </Btn>
        </View>
      )}
      <View className="items-center pt-10">
        <Ring value={pct}>
          <View className="h-40 w-40 items-center justify-center rounded-full bg-white">
            <Avatar name="나" size={64} />
          </View>
        </Ring>
        <Text className="mt-6 text-headline font-bold text-ink">프로필을 만들고 있어요</Text>
        <Text className="mt-2 text-center text-footnote text-sub">
          잠시만 기다려 주세요.{'\n'}나만의 학습 공간을 준비하고 있어요.
        </Text>
        <View className="mt-4 rounded-full bg-mint px-3 py-1">
          <Text className="text-caption text-brand">● 프로필 정보 설정 중 · {pct}%</Text>
        </View>
        <Text className="mt-16 text-caption text-sub">완료되면 자동으로 이동해요</Text>
      </View>
    </Screen>
  );
}

/** p.83 #26 아바타 스타일 선택 */
export function AvatarStyleScreen() {
  const [pick, setPick] = useState('3d');
  return (
    <Screen
      footer={
        <Btn
          kind="cream"
          onPress={() =>
            router.push({ pathname: '/(tabs)/profile/avatar-custom', params: { style: pick } })
          }
        >
          다음
        </Btn>
      }
    >
      <Header
        title="아바타 스타일 선택"
        large={false}
        right={<Badge tone="gray">원본 사진</Badge>}
      />
      <View className="flex-row items-center justify-between">
        <Text className="text-footnote font-semibold text-ink">스타일 비교</Text>
        <Badge>3가지 미리보기</Badge>
      </View>
      <View className="mt-2 gap-3">
        {AV_STYLES.map((s) => (
          <Pressable
            key={s.id}
            onPress={() => setPick(s.id)}
            className={cx(
              'overflow-hidden rounded-2xl border-2',
              pick === s.id ? 'border-brand' : 'border-transparent bg-cream',
            )}
          >
            <View className="h-28 items-center justify-center" style={{ backgroundColor: s.bg }}>
              <Text className="text-display-lg">{s.face}</Text>
            </View>
            <View className="px-3 py-2">
              <Text className="text-footnote font-semibold text-ink">{s.name}</Text>
              <Text className="text-caption2 text-sub">{s.sub}</Text>
            </View>
          </Pressable>
        ))}
      </View>
    </Screen>
  );
}

const COLORS = ['#d9363e', '#5f6b7a', '#e2b33c', '#3b6e5b', '#2f4f86'] as const;

/** p.83 #27 아바타 캐릭터 색상 선택 */
export function AvatarCustomScreen() {
  const qc = useQueryClient();
  const { style = '3d' } = useLocalSearchParams<{ style?: string }>();
  const selectedStyle = AV_STYLES.find((s) => s.id === style) ?? AV_STYLES[1]!;
  const [g, setG] = useState<'남자' | '여자'>('여자');
  const [c, setC] = useState<string>(COLORS[3]);
  const save = useMutation({
    mutationFn: () =>
      api.me.saveAvatar({
        style: selectedStyle.id,
        gender: g === '남자' ? 'male' : 'female',
        color: c,
      }),
    onSuccess: () => {
      router.dismissTo('/(tabs)/profile');
      qc.invalidateQueries({ queryKey: ['me'] });
      toast('아바타를 저장했어요');
    },
    onError: () => toast('아바타를 저장하지 못했어요. 다시 시도해 주세요'),
  });
  return (
    <Screen
      footer={
        <Btn kind="cream" loading={save.isPending} onPress={() => save.mutate()}>
          아바타 선택하기
        </Btn>
      }
    >
      <Header
        title="아바타 커스터마이징"
        large={false}
        right={<Badge tone="gray">원본 사진</Badge>}
      />
      <Segment items={['남자', '여자'] as const} value={g} onChange={setG} />
      <View
        className="mt-4 aspect-square items-center justify-center rounded-2xl border border-line"
        style={{ backgroundColor: `${c}22` }}
      >
        <Text className="text-timer-xl">
          {g === '여자' ? selectedStyle.face : selectedStyle.maleFace}
        </Text>
      </View>
      <Text className="mt-2 text-center text-caption text-sub">{selectedStyle.name}</Text>
      <View className="mt-4 flex-row gap-2 rounded-2xl bg-cream p-2">
        {COLORS.map((x) => (
          <Pressable
            key={x}
            accessibilityLabel={`색상 ${x}`}
            onPress={() => setC(x)}
            className={cx('h-14 flex-1 rounded-xl', c === x && 'border-4 border-white')}
            style={{ backgroundColor: x }}
          />
        ))}
      </View>
    </Screen>
  );
}
