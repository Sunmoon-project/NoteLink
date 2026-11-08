import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { Image, Linking, Pressable, View } from 'react-native';
import { Text } from '@/components/text';
import Animated, {
  Easing,
  useAnimatedStyle,
  ReduceMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { router, useLocalSearchParams } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { useKeepAwake } from 'expo-keep-awake';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { Camera, Check, Crop, FileText, Mic, RotateCw, X, Zap } from 'lucide-react-native';
import { api, type ImageVerdict } from '@/lib/api';
import { editPhoto } from '@/lib/image-edit';
import { toast } from '@/stores/toast';
import { checkFile, uploadToBlob, type LocalFile } from '@/lib/upload';
import { useDraft } from '@/stores/draft';
import { Alert, Badge, Btn, Chip, Header, Input, Label, Screen, Two, cx } from '@/components/ui';
import { C, ICON } from '@/theme';

// p.61~65 필기 · 녹음 · 학습 자료 올리기 / p.102 이미지 검사

/** 카메라 권한이 없을 때 */
function NeedPermission({ onGrant, canAsk }: { onGrant: () => void; canAsk: boolean }) {
  return (
    <View className="flex-1 items-center justify-center bg-black px-10">
      <Text className="text-center text-body font-bold text-white">카메라 권한이 필요해요</Text>
      <Text className="mt-2 text-center text-footnote text-white/60">
        필기와 문서를 촬영하려면 카메라 접근을 허용해 주세요.
      </Text>
      <Btn className="mt-6 w-56" onPress={canAsk ? onGrant : () => Linking.openSettings()}>
        {canAsk ? '권한 허용하기' : '설정에서 허용하기'}
      </Btn>
      <Pressable onPress={() => router.back()} className="mt-3">
        <Text className="text-white/70">닫기</Text>
      </Pressable>
    </View>
  );
}

/** p.61 #10 카메라 촬영 / p.65 #18 문서 스캔 */
/** 스캔을 마칠 때 초안에 넣을 페이지: '+ 추가'면 기존 페이지 뒤에, 아니면 새로 */
export const scanPages = (prev: LocalFile[], pages: LocalFile[], append: boolean) =>
  append ? [...prev, ...pages] : pages;

export function CameraScreen() {
  const { mode, append } = useLocalSearchParams<{ mode?: 'scan'; append?: '1' }>();
  const scan = mode === 'scan';
  const insets = useSafeAreaInsets();
  const [perm, request] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const [torch, setTorch] = useState(false);
  const [facing, setFacing] = useState<'back' | 'front'>('back');
  const [pages, setPages] = useState<LocalFile[]>([]);
  const [busy, setBusy] = useState(false);
  if (!perm) return <View className="flex-1 bg-black" />;
  if (!perm.granted) return <NeedPermission onGrant={request} canAsk={perm.canAskAgain} />;

  const shoot = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const p = await cam.current?.takePictureAsync({ quality: 0.85 });
      if (!p) return;
      const f: LocalFile = {
        uri: p.uri,
        name: `${scan ? 'scan' : 'note'}_${Date.now()}.jpg`,
        mimeType: 'image/jpeg',
      };
      if (scan) setPages((x) => [...x, f]);
      else {
        useDraft.getState().set({ files: [f] });
        router.replace('/capture/photo-check');
      }
    } finally {
      setBusy(false);
    }
  };
  const openGallery = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      quality: 0.85,
    });
    if (r.canceled) return;
    useDraft.getState().set({
      source: 'gallery',
      files: r.assets.map((a, i) => ({
        uri: a.uri,
        name: a.fileName ?? `photo_${i + 1}.jpg`,
        mimeType: a.mimeType,
        size: a.fileSize,
      })),
    });
    router.replace('/capture/picked');
  };

  return (
    <View
      className="flex-1 bg-black"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom + 16 }}
    >
      <StatusBar style="light" />
      <CameraView
        ref={cam}
        style={{ position: 'absolute', inset: 0 }}
        facing={facing}
        enableTorch={torch}
      />
      <View className="flex-row items-center justify-between px-5 pt-3">
        <Pressable accessibilityLabel="닫기" onPress={() => router.back()} hitSlop={10}>
          <X size={ICON.lg} color="#fff" />
        </Pressable>
        <Pressable accessibilityLabel="플래시" onPress={() => setTorch((t) => !t)} hitSlop={10}>
          <Zap size={ICON.lg} color={torch ? C.sun : 'rgba(255,255,255,.7)'} />
        </Pressable>
      </View>
      <Text className="mt-6 text-center text-footnote text-white">
        {scan ? '문서를 프레임 안에 맞춰주세요' : '필기한 종이를 프레임 안에 맞춰주세요'}
      </Text>
      <View
        className={cx(
          'mx-auto mt-4 aspect-[3/4] w-[85%] rounded-xl border-2',
          scan ? 'border-brand' : 'border-dashed border-brand/80',
        )}
      >
        {scan && pages.length > 0 && (
          <View className="absolute -top-3 -right-3 h-7 w-7 items-center justify-center rounded-full bg-brand">
            <Check size={ICON.sm} color="#fff" />
          </View>
        )}
      </View>
      {!scan && (
        <Text className="mt-3 text-center text-caption2 text-white/60">
          밝은 곳에서 촬영하면 더 선명해요
        </Text>
      )}
      <View className="mt-auto flex-row items-center justify-between px-8">
        {scan ? (
          <>
            <View className="rounded-full border border-white/40 px-3 py-1.5">
              <Text className="text-caption text-white">{pages.length}페이지</Text>
            </View>
            <Pressable
              accessibilityLabel="촬영"
              onPress={shoot}
              className="h-[72px] w-[72px] items-center justify-center rounded-full border-4 border-white"
            >
              <View className="h-14 w-14 rounded-full bg-white" />
            </Pressable>
            <Pressable
              disabled={!pages.length}
              onPress={() => {
                // '+ 추가'로 들어왔으면 이미 스캔한 페이지 뒤에 붙인다 (다시 스캔은 새로 시작)
                useDraft
                  .getState()
                  .set({ files: scanPages(useDraft.getState().files, pages, append === '1') });
                router.replace('/capture/scan-check');
              }}
              className={cx('rounded-full bg-brand px-4 py-1.5', !pages.length && 'opacity-40')}
            >
              <Text className="text-footnote font-semibold text-white">완료</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Pressable
              accessibilityLabel="갤러리"
              onPress={openGallery}
              className="h-11 w-11 rounded-lg bg-white/25"
            />
            <Pressable
              accessibilityLabel="촬영"
              onPress={shoot}
              className="h-[72px] w-[72px] items-center justify-center rounded-full border-4 border-white"
            >
              <View className="h-14 w-14 rounded-full bg-white" />
            </Pressable>
            <Pressable
              accessibilityLabel="카메라 전환"
              onPress={() => setFacing((f) => (f === 'back' ? 'front' : 'back'))}
              className="h-11 w-11 items-center justify-center rounded-full bg-white/15"
            >
              <RotateCw size={ICON.md} color="#fff" />
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

/** p.61 #11 사진 확인 */
export function PhotoCheckScreen() {
  const file = useDraft((s) => s.files[0]);
  const [rot, setRot] = useState(0);
  const [saving, setSaving] = useState(false);
  const saveLock = useRef(false);
  const [crop, setCrop] = useState(false);
  const [rendered, setRendered] = useState<{
    source: LocalFile;
    rot: number;
    crop: boolean;
    file: LocalFile;
  } | null>(null);
  const previewReady =
    !!file && rendered?.source === file && rendered.rot === rot && rendered.crop === crop;
  const preview = previewReady ? rendered.file : null;
  useEffect(() => {
    let active = true;
    if (!file) return;
    editPhoto(file, rot % 360, crop)
      .then((result) => {
        if (active) {
          setRendered({ source: file, rot, crop, file: result });
        }
      })
      .catch(() => {
        if (active) toast('사진을 보정하지 못했어요. 다시 시도해 주세요');
      });
    return () => {
      active = false;
    };
  }, [file, rot, crop]);
  const apply = async () => {
    if (!file || !preview || !previewReady || saveLock.current) return;
    saveLock.current = true;
    setSaving(true);
    try {
      const edited = preview;
      useDraft.getState().set({ files: [edited, ...useDraft.getState().files.slice(1)] });
      router.replace('/capture/picked');
    } catch {
      toast('사진을 보정하지 못했어요. 다시 시도해 주세요');
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  };
  return (
    <Screen
      footer={
        <Two>
          <Btn kind="outline" onPress={() => router.replace('/capture/camera')}>
            다시 촬영
          </Btn>
          <Btn disabled={!file || !previewReady} loading={saving} onPress={apply}>
            다음
          </Btn>
        </Two>
      }
    >
      <Header title="사진 확인" back={false} />
      <View
        className={cx(
          'aspect-square items-center justify-center self-center overflow-hidden rounded-xl bg-cream',
          'w-full',
        )}
      >
        {file ? (
          <Image
            source={{ uri: (preview ?? file).uri }}
            className="h-full w-full"
            resizeMode="contain"
          />
        ) : (
          <View className="flex-row items-center gap-1.5">
            <Camera size={ICON.xs} color={C.sub} />
            <Text className="text-footnote text-sub">촬영된 필기 이미지</Text>
          </View>
        )}
      </View>
      <View className="mt-4 flex-row gap-2">
        <Chip small onPress={() => setRot((r) => r + 90)}>
          <View className="flex-row items-center gap-1">
            <RotateCw size={ICON.xs} color={C.ink} />
            <Text className="text-caption text-ink">회전</Text>
          </View>
        </Chip>
        <Chip small on={crop} onPress={() => setCrop((c) => !c)}>
          <View className="flex-row items-center gap-1">
            <Crop size={ICON.xs} color={crop ? '#fff' : C.ink} />
            <Text className={cx('text-caption', crop ? 'text-white' : 'text-ink')}>자르기</Text>
          </View>
        </Chip>
      </View>
    </Screen>
  );
}

/** p.62 #13 선택 사진 확인 + p.102 이미지 검사 (기기 → AI 서버) */
export function PickedScreen() {
  const { files, fileVersion, set } = useDraft();
  const [dlg, setDlg] = useState<null | 'bad' | 'blurry'>(null);
  // 1) 형식 · 용량은 기기에서 먼저
  const local = Object.fromEntries(files.map((f) => [f.uri, checkFile('image', f)]));
  const bad = files.filter((f) => !local[f.uri]?.ok);
  // 2) 통과한 사진만 AI 서버가 필기 여부 · 글씨 신뢰도 판별
  const check = useQuery({
    queryKey: ['image-check', fileVersion],
    queryFn: async () => {
      const checked = await Promise.all(
        files
          .filter((f) => local[f.uri]?.ok)
          .map(async (f) => {
            const cached = useDraft.getState().uploads.find((upload) => upload.file === f);
            const uri = cached?.url ?? (await uploadToBlob('image', f));
            useDraft.getState().rememberUpload(f, uri);
            return {
              // 원본 이름과도 충돌하지 않도록 모든 파일에 서로 다른 위치를 붙인다.
              name: `${files.indexOf(f)}-${f.name}`,
              localUri: f.uri,
              sizeBytes: f.size ?? 0,
              uri,
            };
          }),
      );
      const result = await api.content.checkImages(
        checked.map(({ localUri: _localUri, ...request }) => request),
      );
      if (
        checked.some(
          (f) =>
            !result.some(
              (v) =>
                v.name === f.name &&
                ['ok', 'blurry', 'not_handwriting', 'not_allowed'].includes(v.verdict),
            ),
        )
      )
        throw new Error('검사 결과가 누락됐어요');
      return checked.map((f) => ({
        ...result.find((v) => v.name === f.name)!,
        localUri: f.localUri,
      }));
    },
    retry: false,
    enabled: files.length > 0,
  });
  const verdicts: Record<string, ImageVerdict> = Object.fromEntries(
    (check.data ?? []).map((v) => [v.localUri, v.verdict]),
  );
  // 걸러진 사진 수가 바뀌면 안내창을 연다 (렌더 중 상태 조정)
  const [badCount, setBadCount] = useState(0);
  if (bad.length !== badCount) {
    setBadCount(bad.length);
    if (bad.length) setDlg('bad');
  }
  const v = (f: LocalFile): ImageVerdict | undefined =>
    !local[f.uri]?.ok ? 'not_allowed' : verdicts[f.uri];
  const prohibited = files.filter((f) => v(f) === 'not_allowed');
  const notHand = files.filter((f) => v(f) === 'not_handwriting');
  const blurry = files.find((f) => v(f) === 'blurry');
  const remove = (uri: string) => set({ files: files.filter((f) => f.uri !== uri) });
  const selectPhotos = async (append: boolean) => {
    const r = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      quality: 0.85,
    });
    if (!r.canceled)
      set({
        files: [
          ...(append ? useDraft.getState().files : []),
          ...r.assets.map((a, i) => ({
            uri: a.uri,
            name: a.fileName ?? `photo_${i + 1}.jpg`,
            mimeType: a.mimeType,
            size: a.fileSize,
          })),
        ].filter((file, index, all) => all.findIndex((f) => f.uri === file.uri) === index),
      });
  };
  const reselect = () => selectPhotos(false);
  const addPhotos = () => selectPhotos(true);
  const next = () => {
    if (!check.isSuccess || check.isFetching || prohibited.length || notHand.length) return;
    if (blurry && dlg !== 'blurry') return setDlg('blurry');
    router.replace('/convert');
  };
  const tag = (f: LocalFile) => {
    const r = v(f);
    if (!r) return <Badge tone="gray">확인 중…</Badge>;
    return r === 'ok' ? (
      <Badge>필기 확인됨</Badge>
    ) : r === 'not_allowed' ? (
      <Badge tone="danger">올릴 수 없는 파일</Badge>
    ) : r === 'not_handwriting' ? (
      <Badge tone="danger">필기가 아니에요</Badge>
    ) : (
      <Badge tone="sun">읽기 어려워요</Badge>
    );
  };
  return (
    <Screen
      footer={
        notHand.length && !bad.length ? (
          <View className="gap-2">
            <Btn
              onPress={() => set({ files: files.filter((f) => v(f) !== 'not_handwriting') })}
            >{`필기 사진 ${files.length - notHand.length}장만 올리기`}</Btn>
            <Btn kind="outline" onPress={reselect}>
              사진 다시 선택
            </Btn>
          </View>
        ) : (
          <Btn
            disabled={!files.length || !!prohibited.length || check.isFetching || !check.isSuccess}
            onPress={next}
          >
            다음
          </Btn>
        )
      }
    >
      {notHand.length > 0 && !bad.length && (
        <View className="mt-3 rounded-2xl bg-sun/20 px-4 py-3">
          <Text className="text-footnote font-semibold text-ink">
            ● 필기가 아닌 사진이 {notHand.length}장 있어요
          </Text>
          <Text className="text-caption text-sub">제외하고 올리거나 다시 선택해요</Text>
        </View>
      )}
      <Header title={`선택한 사진 (${files.length}장)`} />
      {check.isError && (
        <View>
          <Text>사진 검사에 실패했어요. 다시 시도해 주세요.</Text>
          <Btn onPress={() => check.refetch()}>다시 검사</Btn>
        </View>
      )}
      <View className="gap-2">
        {files.map((f) => (
          <View
            key={f.uri}
            className={cx(
              'flex-row items-center gap-3 rounded-2xl p-3',
              v(f) === 'not_handwriting' ? 'border border-danger/40 bg-white' : 'bg-cream',
            )}
          >
            <Image source={{ uri: f.uri }} className="h-12 w-12 rounded-lg bg-mint" />
            <View className="flex-1">
              <Text className="text-subhead font-semibold text-ink" numberOfLines={1}>
                {f.name}
              </Text>
              <Text className="text-caption2 text-sub">
                {f.size ? `${(f.size / 1024 / 1024).toFixed(1)}MB` : ''}
              </Text>
              <View className="mt-1">{tag(f)}</View>
            </View>
            <Pressable
              accessibilityLabel="삭제"
              onPress={() => remove(f.uri)}
              className="h-7 w-7 items-center justify-center rounded-full bg-white"
            >
              <X size={ICON.xs} color={C.ink} />
            </Pressable>
          </View>
        ))}
      </View>
      <Pressable
        onPress={addPhotos}
        className="mt-2 h-12 items-center justify-center rounded-2xl border border-brand/40"
      >
        <Text className="text-subhead text-sub">+ 사진 추가</Text>
      </Pressable>
      <Alert
        open={dlg === 'bad'}
        title="올릴 수 없는 파일이에요"
        body={`JPG · PNG · HEIC, 20MB 이하만\n올릴 수 있어요.`}
        secondary="닫기"
        onSecondary={() => {
          setDlg(null);
          set({ files: files.filter((f) => local[f.uri]?.ok) });
        }}
        primary="다시 선택"
        onPrimary={() => {
          setDlg(null);
          reselect();
        }}
      />
      <Alert
        open={dlg === 'blurry'}
        tone="sun"
        title="글씨를 읽기 어려워요"
        body={`사진이 흐리거나 어두워요.\n다시 찍으면 더 정확히 정리돼요.`}
        secondary="그대로 올리기"
        onSecondary={() => router.replace('/convert')}
        primary="다시 촬영"
        onPrimary={() => router.replace('/capture/camera')}
      />
    </Screen>
  );
}

/** p.63 #14 녹음 파일 선택 */
export function RecUploadScreen() {
  const { files, set } = useDraft();
  const file = files[0];
  const pick = async () => {
    const r = await DocumentPicker.getDocumentAsync({
      type: ['audio/*'],
      copyToCacheDirectory: true,
    });
    if (r.canceled) return;
    const a = r.assets[0];
    if (!a) return;
    set({
      files: [{ uri: a.uri, name: a.name, mimeType: a.mimeType, size: a.size }],
      title: a.name.replace(/\.\w+$/, ''),
    });
  };
  return (
    <Screen
      footer={
        <Btn
          disabled={!file}
          onPress={() => {
            router.replace('/convert');
          }}
        >
          다음
        </Btn>
      }
    >
      <Header title="녹음 올리기" center />
      <Pressable
        onPress={pick}
        className="mt-2 items-center rounded-2xl border-2 border-dashed border-brand/40 bg-mint/60 py-6"
      >
        <View className="h-10 w-10 items-center justify-center rounded-full border-2 border-brand/40">
          {file ? <Check size={ICON.md} color={C.brand} /> : <Mic size={ICON.md} color={C.brand} />}
        </View>
        <Text className="mt-2 text-footnote font-semibold text-ink">
          {file?.name ?? '탭해서 녹음 파일 선택'}
        </Text>
        <Text className="text-caption2 text-sub">
          {file?.size ? `${(file.size / 1024 / 1024).toFixed(1)}MB` : 'mp3 · m4a · wav'}
        </Text>
      </Pressable>
    </Screen>
  );
}

/** 소리 크기를 읽는 간격 — 파형이 이 간격마다 한 칸씩 흐른다 */
const METER_MS = 120;
/** 파형 막대 한 칸(막대 6 + 사이 4) */
const BAR_STEP = 10;
/**
 * 막대 수. 줄 폭(48 × 10 = 480)이 가장 넓은 폰의 상자(440 - 양옆 여백)보다 넓어야
 * 막대가 상자 안에서 생기고 사라지지 않고 양 끝 바깥에서 들고 난다
 */
export const BAR_COUNT = 48;
/**
 * 파형 상자의 최대 폭. 줄(476 = 48 × 6 + 47 × 4)이 가운데에 놓이고 한 칸(10) 밀리므로,
 * 상자 폭의 절반이 476/2 - 10 - 6(막대) = 222 이하여야 양 끝 막대가 늘 상자 밖에 있다.
 * 태블릿 등 더 넓은 화면에서도 상자를 이 폭으로 묶어 둔다
 */
export const WAVE_MAX_W = 440;

/**
 * 녹음 파형. 새 소리 크기가 들어올 때마다 막대를 한 칸씩 밀되, 칸이 뚝 바뀌지 않게
 * 줄 전체를 한 칸 오른쪽에서 제자리로 METER_MS 동안 일정한 속도로 흘린다(UI 스레드).
 * 그래서 다음 값이 들어올 때까지 쉬지 않고 왼쪽으로 흐르는 것처럼 보인다
 */
export function Waveform({ bars, live }: { bars: number[]; live: boolean }) {
  const x = useSharedValue(0);
  useEffect(() => {
    if (!live) return;
    x.set(BAR_STEP);
    // 동작 줄이기면 흐르지 않고 바로 제자리(시스템 설정을 따른다)
    x.set(
      withTiming(0, {
        duration: METER_MS,
        easing: Easing.linear,
        reduceMotion: ReduceMotion.System,
      }),
    );
  }, [bars, live, x]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() }] }));
  return (
    <View
      className="mt-4 h-20 w-full items-center justify-center self-center overflow-hidden rounded-lg bg-black/30"
      style={{ maxWidth: WAVE_MAX_W }}
    >
      <Animated.View className="flex-row items-center gap-1" style={style}>
        {bars.map((h, i) => (
          <View key={i} className="w-1.5 rounded-full bg-orange" style={{ height: live ? h : 6 }} />
        ))}
      </Animated.View>
    </View>
  );
}

function RecordingAwake() {
  useKeepAwake('recording');
  return null;
}

/** p.63 #15 실시간 녹음 — 기기 마이크 · 소리 크기로 파형 */
export function RecLiveScreen() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me.get() });
  const keepAwake = me.data?.settings.keepScreenOnWhileRecording ?? false;
  const insets = useSafeAreaInsets();
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const st = useAudioRecorderState(recorder, METER_MS);
  const [bars, setBars] = useState<number[]>(Array(BAR_COUNT).fill(6));
  const [denied, setDenied] = useState(false);
  const alive = useRef(true);
  const ready = useRef(false);
  const finishing = useRef(false);
  const [confirmClose, setConfirmClose] = useState(false);
  useEffect(() => {
    alive.current = true;
    (async () => {
      try {
        const p = await AudioModule.requestRecordingPermissionsAsync();
        if (!alive.current) return;
        if (!p.granted) return setDenied(true);
        await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
        if (!alive.current) {
          await setAudioModeAsync({ allowsRecording: false });
          return;
        }
        await recorder.prepareToRecordAsync();
        if (!alive.current) {
          await recorder.stop();
          await setAudioModeAsync({ allowsRecording: false });
          return;
        }
        recorder.record();
        ready.current = true;
      } catch {
        if (alive.current) toast('녹음을 시작하지 못했어요. 권한과 마이크를 확인해주세요');
        await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      }
    })();
    return () => {
      alive.current = false;
      ready.current = false;
      recorder
        .stop()
        .catch(() => {})
        .finally(() => setAudioModeAsync({ allowsRecording: false }).catch(() => {}));
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // 녹음 시간이 갱신될 때마다 파형 막대를 한 칸 민다 (렌더 중 상태 조정)
  const [barAt, setBarAt] = useState(st.durationMillis);
  if (st.isRecording && st.durationMillis !== barAt) {
    setBarAt(st.durationMillis);
    const db = st.metering ?? -60; // -160(무음) ~ 0
    const h = Math.max(6, Math.min(48, ((db + 60) / 60) * 48));
    setBars((b) => [...b.slice(1), h]);
  }
  const toggle = () => {
    if (!ready.current || finishing.current) return;
    try {
      if (st.isRecording) recorder.pause();
      else recorder.record();
    } catch {
      toast('녹음 상태를 바꾸지 못했어요');
    }
  };
  const finish = async () => {
    if (!ready.current || finishing.current) return;
    finishing.current = true;
    try {
      await recorder.stop();
      if (!alive.current) return;
      if (!recorder.uri) throw new Error('녹음 파일이 없어요');
      await setAudioModeAsync({ allowsRecording: false });
      if (!alive.current) return;
      useDraft.getState().set({
        kind: 'recording',
        source: 'live_recording',
        files: [{ uri: recorder.uri, name: `강의녹음_${Date.now()}.m4a`, mimeType: 'audio/mp4' }],
        title: '실시간 강의 녹음',
      });
      router.replace('/convert');
    } catch {
      if (alive.current) toast('녹음 파일을 저장하지 못했어요. 다시 시도해주세요');
    } finally {
      finishing.current = false;
    }
  };
  if (denied) return <NeedPermission onGrant={() => Linking.openSettings()} canAsk={false} />;
  const sec = Math.floor(st.durationMillis / 1000);
  const t = `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  return (
    <View
      className="flex-1 bg-night px-5"
      style={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }}
    >
      <StatusBar style="light" />
      {keepAwake && <RecordingAwake />}
      <Pressable
        accessibilityLabel="닫기"
        className="self-start"
        onPress={() => setConfirmClose(true)}
        hitSlop={10}
      >
        <X size={ICON.lg} color="#fff" />
      </Pressable>
      <Alert
        open={confirmClose}
        title="녹음을 그만둘까요?"
        body="지금까지 녹음한 내용은 저장되지 않아요."
        secondary="계속 녹음"
        onSecondary={() => setConfirmClose(false)}
        primary="그만두기"
        onPrimary={() => router.back()}
      />
      <View className="mt-24 self-center rounded-full border border-white/50 px-5 py-1">
        <Text className="tabular-nums text-title1 text-white">{t}</Text>
      </View>
      <Waveform bars={bars} live={st.isRecording} />
      <View className="mt-auto flex-row items-center justify-center gap-10">
        <Pressable
          accessibilityLabel={st.isRecording ? '녹음 일시정지' : '녹음 재개'}
          onPress={toggle}
          className="h-14 w-14 items-center justify-center rounded-full border-2 border-white/60"
        >
          <View
            className={cx('h-5 w-5 bg-danger', st.isRecording ? 'rounded-sm' : 'rounded-full')}
          />
        </Pressable>
        <Pressable onPress={finish} className="rounded-full bg-white/20 px-4 py-1.5">
          <Text className="text-footnote font-semibold text-white">변환 시작</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** p.64 #17 선택 파일 확인 */
export function PickedFileScreen() {
  const { files, title, description, set } = useDraft();
  const f = files[0];
  const ok = f ? checkFile('document', f) : null;
  const pickAgain = async () => {
    const r = await DocumentPicker.getDocumentAsync({
      type: ['application/pdf', 'image/*'],
      copyToCacheDirectory: true,
    });
    const a = r.canceled ? undefined : r.assets[0];
    if (a) set({ files: [{ uri: a.uri, name: a.name, mimeType: a.mimeType, size: a.size }] });
  };
  return (
    <Screen
      footer={
        <Btn disabled={!f || !ok?.ok} onPress={() => router.replace('/convert')}>
          다음
        </Btn>
      }
    >
      <Header title="선택한 파일 (1개)" large={false} />
      {f ? (
        <View className="flex-row items-center gap-3 rounded-2xl bg-cream p-3">
          <View className="h-11 w-11 items-center justify-center rounded-lg bg-mint">
            <FileText size={ICON.md} color={C.sub} />
          </View>
          <View className="flex-1">
            <Text className="text-subhead font-semibold text-ink" numberOfLines={1}>
              {f.name}
            </Text>
            <Text className={cx('text-caption2', ok?.ok ? 'text-sub' : 'text-danger')}>
              {ok?.ok
                ? `${((f.size ?? 0) / 1024 / 1024).toFixed(1)}MB · ${f.name.endsWith('.pdf') ? 'PDF 문서' : '이미지'}`
                : !ok?.ok && 'reason' in ok!
                  ? ok.reason
                  : ''}
            </Text>
          </View>
          <Pressable
            accessibilityLabel="삭제"
            onPress={() => set({ files: [] })}
            className="h-7 w-7 items-center justify-center rounded-full bg-white"
          >
            <X size={ICON.xs} color={C.ink} />
          </Pressable>
        </View>
      ) : (
        <Pressable
          onPress={pickAgain}
          className="h-14 items-center justify-center rounded-2xl border border-dashed border-brand/40"
        >
          <Text className="text-subhead text-sub">+ 파일 다시 선택</Text>
        </Pressable>
      )}
      <Label>노트 제목</Label>
      <Input value={title} onChangeText={(t) => set({ title: t })} />
      <Input
        className="mt-3"
        multiline
        value={description}
        onChangeText={(t) => set({ description: t })}
        placeholder="해당 파일에 대한 설명"
      />
    </Screen>
  );
}

/** p.65 #19 스캔 확인 */
export function ScanCheckScreen() {
  const files = useDraft((s) => s.files);
  const [cur, setCur] = useState(0);
  return (
    <Screen
      footer={
        <Two>
          <Btn
            kind="outline"
            onPress={() =>
              router.replace({ pathname: '/capture/camera', params: { mode: 'scan' } })
            }
          >
            다시 스캔
          </Btn>
          <Btn onPress={() => router.replace('/convert')}>다음</Btn>
        </Two>
      }
    >
      <Header title={`문서 스캔 확인 (${files.length}페이지)`} large={false} />
      <View className="flex-row gap-2">
        {files.map((f, i) => (
          <Pressable
            key={f.uri}
            onPress={() => setCur(i)}
            className={cx(
              'h-20 w-14 overflow-hidden rounded-lg bg-cream',
              cur === i && 'border-2 border-brand',
            )}
          >
            <Image source={{ uri: f.uri }} className="h-full w-full" />
            <View className="absolute top-1 left-1 h-4 w-4 items-center justify-center rounded-full bg-ink">
              <Text className="text-caption2 text-white">{i + 1}</Text>
            </View>
          </Pressable>
        ))}
        <Pressable
          onPress={() =>
            router.replace({ pathname: '/capture/camera', params: { mode: 'scan', append: '1' } })
          }
          className="h-20 w-14 items-center justify-center rounded-lg border border-brand/40"
        >
          <Text className="text-caption2 text-sub">+ 추가</Text>
        </Pressable>
      </View>
      <View className="mt-4 aspect-[4/3.6] items-center justify-center overflow-hidden rounded-2xl bg-cream">
        {files[cur] ? (
          <Image source={{ uri: files[cur].uri }} className="h-full w-full" resizeMode="contain" />
        ) : (
          <View className="flex-row items-center gap-1.5">
            <FileText size={ICON.xs} color={C.sub} />
            <Text className="text-footnote text-sub">{cur + 1}페이지 미리보기</Text>
          </View>
        )}
      </View>
    </Screen>
  );
}
