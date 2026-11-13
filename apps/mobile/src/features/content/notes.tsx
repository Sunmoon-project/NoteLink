import { useTour, useTourTarget } from '@/features/tutor/tour';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Text } from '@/components/text';
import Animated, { FadeIn, FadeInDown, FadeOut } from 'react-native-reanimated';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import {
  Camera,
  ChevronRight,
  CircleDot,
  FileText,
  Folder,
  ImageIcon,
  Lightbulb,
  type LucideIcon,
  Mic,
  MoreHorizontal,
  Paperclip,
  PenLine,
  Plus,
  ScanLine,
  Share2,
  Trash2,
  X,
} from 'lucide-react-native';
import type { Material } from '@notelink/shared';
import { api } from '@/lib/api';
import { toast } from '@/stores/toast';
import { useDraft } from '@/stores/draft';
import {
  afterSheetClosed,
  Alert,
  Btn,
  Canvas,
  Card,
  Chip,
  Group,
  Header,
  Input,
  Label,
  LIST_LAYOUT,
  Row,
  Screen,
  Search,
  Sheet,
  Tap,
  Title,
  cx,
} from '@/components/ui';
import { NetBanner } from '@/components/NetBanner';
import { useTabRefresh } from '@/hooks';
import { C, ICON, MOTION } from '@/theme';
import { seoul } from '@/lib/dates';

// p.58~60 노트 목록 · 새 자료 · 강의 상세 · 올리기 방식 선택

const TAGS = ['수학', '영어', '국어', '과학', '사회', '자격증', '기타'];
const KIND = {
  recording: [Mic, '녹음'],
  handwriting: [PenLine, '필기'],
  document: [FileText, '문서'],
} as const;
/** 자료 종류마다 다른 색 타일 — 목록에서 종류를 글자 없이도 알아본다 */
const TILE = {
  recording: ['bg-sun/20', C.ink],
  handwriting: ['bg-mint', C.brand],
  document: ['bg-blue/10', C.blue],
} as const;

const EmptyNote = ({ children }: { children?: React.ReactNode }) => (
  <View className="items-center">
    <View className="h-16 w-16 items-center justify-center rounded-full bg-mint">
      <Folder size={ICON.xl} color={C.brand} />
    </View>
    <Text className="mt-4 text-body font-bold text-ink">아직 학습 자료가 없어요</Text>
    <Text className="mt-1 text-footnote text-sub">
      녹음이나 필기, 문서를 올려서 첫 자료를 만들어보세요
    </Text>
    {children && <View className="mt-6 w-[200px]">{children}</View>}
  </View>
);

function Fab({
  onPress,
  open,
  tour,
}: {
  onPress: () => void;
  open?: boolean;
  /** 처음 안내가 짚을 자리 */
  tour?: React.RefObject<View | null>;
}) {
  return (
    <Pressable
      ref={tour}
      accessibilityLabel={open ? '닫기' : '추가'}
      onPress={onPress}
      className={cx(
        'absolute right-5 bottom-5 z-30 h-14 w-14 items-center justify-center rounded-full shadow-lg',
        'bg-brand',
      )}
    >
      {open ? <X size={ICON.lg} color="#fff" /> : <Plus size={ICON.lg} color="#fff" />}
    </Pressable>
  );
}

export function NoteListScreen() {
  // 처음 안내의 '자료 올리기'가 짚는 자리(폴더가 없으면 폴더 만들기, 있으면 + 버튼)
  const addTarget = useTourTarget('note-add');
  const { upload } = useLocalSearchParams<{ upload?: 'hand' | 'rec' }>();
  const folders = useQuery({ queryKey: ['folders'], queryFn: api.content.folders });
  const refresh = useTabRefresh(folders);
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('전체');
  const list = (folders.data ?? []).filter(
    (f) => (tag === '전체' || f.subjectName === tag) && f.title.includes(q),
  );
  const tags = ['전체', ...new Set((folders.data ?? []).map((f) => f.subjectName ?? ''))];

  const consumedUpload = useRef<string | undefined>(undefined);
  // 종료 요약에서 "필기 사진 / 녹음"을 누르고 들어온 경우 첫 폴더로 바로 이동
  useEffect(() => {
    if (!upload) {
      consumedUpload.current = undefined;
      return;
    }
    if (!folders.data || consumedUpload.current === upload) return;
    consumedUpload.current = upload;
    router.setParams({ upload: undefined });
    if (folders.data[0])
      router.push({
        pathname: '/(tabs)/note/folder/[id]',
        params: { id: folders.data[0]._id, upload },
      });
    else router.push('/note-new/tag');
  }, [upload, folders.data]);

  return (
    <Canvas>
      <Screen refresh={refresh}>
        <NetBanner />
        <Title>노트</Title>
        <View>
          <Search value={q} onChangeText={setQ} placeholder="학습 폴더 검색" />
        </View>
        {folders.isError && !folders.data && (
          <View className="items-center gap-3 py-12">
            <Text className="text-footnote text-sub">학습 폴더를 불러오지 못했어요</Text>
            <Btn small onPress={() => void folders.refetch()}>
              학습 폴더 다시 시도
            </Btn>
          </View>
        )}
        {folders.isSuccess && folders.data.length === 0 ? (
          <View className="pt-24">
            <EmptyNote>
              <View ref={addTarget} collapsable={false}>
                <Btn onPress={() => router.push('/note-new/tag')}>학습 폴더 만들기</Btn>
              </View>
            </EmptyNote>
          </View>
        ) : (
          <>
            <View className="mt-4 flex-row gap-2">
              {tags.map((t) => (
                <Chip key={t} small on={tag === t} onPress={() => setTag(t)}>
                  {t}
                </Chip>
              ))}
            </View>
            <View className="mt-6 flex-row flex-wrap justify-between gap-y-5">
              {list.map((f) => (
                <Card
                  key={f._id}
                  onPress={() =>
                    router.push({ pathname: '/(tabs)/note/folder/[id]', params: { id: f._id } })
                  }
                  className="w-[47.5%] p-3.5"
                >
                  <View className="h-20 items-center justify-center rounded-xl bg-mint">
                    <Folder size={ICON.xl} color={C.brand} />
                  </View>
                  <Text className="mt-3 px-1 text-subhead font-semibold text-ink">{f.title}</Text>
                  <Text className="mt-0.5 px-1 pb-1 text-caption2 text-sub">
                    {f.subjectName} · {seoul(f.createdAt).getMonth() + 1}/
                    {seoul(f.createdAt).getDate()} · 자료 {f.materialCount}개
                  </Text>
                </Card>
              ))}
            </View>
            {folders.isSuccess && list.length === 0 && (
              <Text className="py-10 text-center text-footnote text-sub">
                ‘{q}’에 맞는 자료가 없어요
              </Text>
            )}
          </>
        )}
      </Screen>
      {!!folders.data?.length && (
        <Fab tour={addTarget} onPress={() => router.push('/note-new/tag')} />
      )}
    </Canvas>
  );
}

const Steps = ({ n }: { n: 0 | 1 }) => (
  <View className="flex-row gap-1">
    {[0, 1].map((i) => (
      <View
        key={i}
        className={cx('h-1.5 w-1.5 rounded-full', i === n ? 'bg-brand' : 'bg-cream-2')}
      />
    ))}
  </View>
);

export function NoteTagScreen() {
  const [tag, setTag] = useState('수학');
  return (
    <Canvas>
      <Screen
        footer={
          <Btn onPress={() => router.push({ pathname: '/note-new/title', params: { tag } })}>
            다음
          </Btn>
        }
      >
        <Header title="태그 설정" right={<Steps n={0} />} />
        <Text className="mt-4 mb-3 text-subhead font-semibold text-ink">과목을 선택해주세요</Text>
        <View className="flex-row flex-wrap gap-2">
          {TAGS.map((t) => (
            <Chip key={t} on={tag === t} onPress={() => setTag(t)}>
              {t}
            </Chip>
          ))}
        </View>
      </Screen>
    </Canvas>
  );
}

export function NoteTitleScreen() {
  const { tag = '기타' } = useLocalSearchParams<{ tag?: string }>();
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const d = seoul();
  const create = useMutation({
    mutationFn: () => api.content.createFolder({ title: title.trim(), subjectName: tag }),
    onSuccess: (folder) => {
      qc.invalidateQueries({ queryKey: ['folders'] });
      router.dismissTo('/(tabs)/note');
      toast('학습 폴더를 만들었어요');
      // 처음 안내에서 「첫 학습 폴더 만들기」로 왔으면 새 폴더로 들어가 + 버튼을 이어서 알려 준다
      const tour = useTour.getState();
      if (tour.afterFolder) {
        tour.setAfterFolder(false);
        router.push({ pathname: '/(tabs)/note/folder/[id]', params: { id: folder._id } });
        tour.start('folder');
      }
    },
  });
  return (
    <Canvas>
      <Screen
        footer={
          <Btn disabled={!title.trim()} loading={create.isPending} onPress={() => create.mutate()}>
            완료
          </Btn>
        }
      >
        <Header title="폴더 이름" right={<Steps n={1} />} />
        <Label>이름</Label>
        <Input
          value={title}
          onChangeText={setTitle}
          placeholder="폴더 이름을 입력해 주세요"
          autoFocus
        />
        <Pressable
          onPress={() => setTitle(`${d.getMonth() + 1}월 ${d.getDate()}일 ${tag}`)}
          className="mt-2"
        >
          <View className="flex-row items-center gap-1.5">
            <Lightbulb size={ICON.xs} color={C.brand} />
            <Text className="text-caption text-brand">
              추천: {d.getMonth() + 1}월 {d.getDate()}일 {tag}
            </Text>
          </View>
        </Pressable>
      </Screen>
    </Canvas>
  );
}

const summaryState = (m: Material) =>
  m.processing.status === 'done'
    ? '자동 요약 완료'
    : m.processing.status === 'failed'
      ? '요약 실패'
      : '요약 중';

export function FolderScreen() {
  // 첫 폴더 안내가 짚는 + 버튼
  const addTarget = useTourTarget('folder-add');
  const { id, upload } = useLocalSearchParams<{ id: string; upload?: 'hand' | 'rec' | 'doc' }>();
  const qc = useQueryClient();
  const folders = useQuery({ queryKey: ['folders'], queryFn: api.content.folders });
  const folder = folders.data?.find((f) => f._id === id);
  const mats = useQuery({ queryKey: ['materials', id], queryFn: () => api.content.materials(id) });
  const [filter, setFilter] = useState('전체');
  const [dial, setDial] = useState(false);
  const [sheet, setSheet] = useState<null | 'hand' | 'rec' | 'doc' | 'more'>(upload ?? null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const draft = useDraft();
  const del = useMutation({
    mutationFn: () => api.content.deleteFolder(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['folders'] });
      router.back();
      toast('폴더를 삭제했어요');
    },
  });

  const items = (mats.data ?? []).filter((m) => filter === '전체' || KIND[m.kind][1] === filter);
  const open = (m: Material) =>
    router.push({
      pathname:
        m.kind === 'recording'
          ? '/(tabs)/note/rec/[id]'
          : m.kind === 'handwriting'
            ? '/(tabs)/note/hand/[id]'
            : '/(tabs)/note/doc/[id]',
      params: { id: m._id },
    });
  const start = (kind: Material['kind'], source: Material['source']) => {
    draft.reset();
    draft.set({ folderId: id, kind, source });
    setSheet(null);
  };

  const pickGallery = async () => {
    start('handwriting', 'gallery');
    await afterSheetClosed();
    const r = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: 10,
      quality: 0.85,
    });
    if (r.canceled) return;
    useDraft.getState().set({
      files: r.assets.map((a, i) => ({
        uri: a.uri,
        name: a.fileName ?? `photo_${i + 1}.jpg`,
        mimeType: a.mimeType,
        size: a.fileSize,
      })),
    });
    router.push('/capture/picked');
  };
  const pickAudio = async () => {
    start('recording', 'audio_file');
    router.push('/capture/rec-upload');
  };
  const pickDoc = async () => {
    start('document', 'file');
    await afterSheetClosed();
    const r = await DocumentPicker.getDocumentAsync({
      type: ['application/pdf', 'image/*'],
      copyToCacheDirectory: true,
    });
    if (r.canceled) return;
    const a = r.assets[0];
    if (!a) return;
    useDraft.getState().set({
      files: [{ uri: a.uri, name: a.name, mimeType: a.mimeType, size: a.size }],
      title: `${seoul().getMonth() + 1}${String(seoul().getDate()).padStart(2, '0')} - ${a.name.replace(/\.\w+$/, '')}`,
    });
    router.push('/capture/picked-file');
  };

  return (
    <Canvas>
      <Screen>
        <Header
          title={folder?.title}
          sub={
            folder &&
            `${folder.subjectName} · ${seoul(folder.createdAt).getMonth() + 1}/${seoul(folder.createdAt).getDate()} 생성`
          }
          large={false}
          right={
            <Pressable
              accessibilityLabel="폴더 옵션"
              onPress={() => setSheet('more')}
              className="h-11 w-11 items-center justify-center rounded-full bg-white"
            >
              <MoreHorizontal size={ICON.md} color={C.ink} />
            </Pressable>
          }
        />
        <View className="flex-row gap-2">
          {['전체', '문서', '필기', '녹음'].map((t) => (
            <Chip key={t} small on={filter === t} onPress={() => setFilter(t)}>
              {t}
            </Chip>
          ))}
        </View>
        {mats.isError && !mats.data && (
          <View className="items-center gap-3 py-12">
            <Text className="text-footnote text-sub">자료를 불러오지 못했어요</Text>
            <Btn small onPress={() => void mats.refetch()}>
              자료 다시 시도
            </Btn>
          </View>
        )}
        {mats.isSuccess && mats.data.length === 0 ? (
          <View className="pt-24">
            <EmptyNote />
          </View>
        ) : (
          <>
            {mats.data && (
              <Text className="mt-7 mb-3 px-1 text-caption text-sub">
                자료 {mats.data.length}개
              </Text>
            )}
            <View className="overflow-hidden rounded-card bg-white">
              {items.map((m, i) => {
                const KindIcon = KIND[m.kind][0];
                const [tile, tint] = TILE[m.kind];
                // 서버가 처리 정보를 아직 안 붙인 자료도 있다 (등록 직후)
                const st = m.processing?.status;
                const busy = !!st && st !== 'done' && st !== 'failed';
                return (
                  <Animated.View
                    key={m._id}
                    layout={LIST_LAYOUT}
                    entering={FadeIn.duration(MOTION.enter)}
                    exiting={FadeOut.duration(MOTION.exit)}
                    className={cx(i > 0 && 'border-t border-fill')}
                  >
                    <Tap
                      scaleTo={0.99}
                      onPress={() => open(m)}
                      className="flex-row items-center gap-3.5 px-5 py-4"
                    >
                      <View
                        className={cx('h-10 w-10 items-center justify-center rounded-xl', tile)}
                      >
                        <KindIcon size={ICON.md} color={tint} />
                      </View>
                      <View className="flex-1">
                        <Text className="text-subhead font-semibold text-ink">{m.title}</Text>
                        <Text className="text-caption2 text-sub">
                          {KIND[m.kind][1]} · {seoul(m.createdAt).getMonth() + 1}/
                          {seoul(m.createdAt).getDate()} 업로드
                          {m.kind === 'recording' && ` · ${summaryState(m)}`}
                        </Text>
                      </View>
                      {/* AI가 아직 처리 중인 자료는 화살표 대신 진행 표시 */}
                      {busy ? (
                        <ActivityIndicator size="small" color={C.brand} />
                      ) : (
                        <ChevronRight size={ICON.sm} color={C.sub} />
                      )}
                    </Tap>
                  </Animated.View>
                );
              })}
            </View>
          </>
        )}
      </Screen>

      {dial && (
        <View className="absolute inset-0 z-20">
          <Pressable className="absolute inset-0 bg-black/45" onPress={() => setDial(false)} />
          <View className="absolute right-5 bottom-24 items-end gap-3">
            {(
              [
                ['doc', '학습 자료 올리기', FileText],
                ['rec', '녹음 올리기 · 실시간 녹음', Mic],
                ['hand', '필기 올리기', PenLine],
              ] as const
            ).map(([k, l, Ic], i) => (
              <Animated.View key={k} entering={FadeInDown.duration(180).delay(i * 30)}>
                <Pressable
                  onPress={() => {
                    setDial(false);
                    setSheet(k);
                  }}
                  className="flex-row items-center gap-2"
                >
                  <View className="rounded-full bg-ink px-3 py-1.5">
                    <Text className="text-footnote font-semibold text-white">{l}</Text>
                  </View>
                  <View className="h-11 w-11 items-center justify-center rounded-full bg-white shadow">
                    <Ic size={ICON.md} color={C.brand} />
                  </View>
                </Pressable>
              </Animated.View>
            ))}
          </View>
        </View>
      )}
      <Fab tour={addTarget} open={dial} onPress={() => setDial((d) => !d)} />

      <Sheet open={sheet === 'hand'} onClose={() => setSheet(null)} title="필기 올리기">
        <UploadOpt
          icon={Camera}
          title="카메라로 촬영"
          sub="필기한 종이를 바로 촬영해요"
          onPress={() => {
            start('handwriting', 'camera');
            router.push('/capture/camera');
          }}
        />
        <UploadOpt
          icon={ImageIcon}
          title="갤러리에서 선택"
          sub="이미 찍어둔 사진을 올려요"
          onPress={pickGallery}
        />
      </Sheet>
      <Sheet open={sheet === 'rec'} onClose={() => setSheet(null)} title="녹음">
        <UploadOpt
          icon={Folder}
          title="녹음 파일 올리기"
          sub="가지고 있는 녹음 파일을 업로드해요"
          onPress={pickAudio}
        />
        <UploadOpt
          icon={CircleDot}
          title="실시간 녹음 시작하기"
          sub="지금 바로 강의·수업을 녹음해요"
          onPress={() => {
            start('recording', 'live_recording');
            router.push('/capture/rec-live');
          }}
        />
      </Sheet>
      <Sheet open={sheet === 'doc'} onClose={() => setSheet(null)} title="학습 자료 올리기">
        <UploadOpt
          icon={Paperclip}
          title="파일 선택 (PDF · 이미지)"
          sub="기기에 저장된 학습 자료를 올려요"
          onPress={pickDoc}
        />
        <UploadOpt
          icon={ScanLine}
          title="스캔하기"
          sub="문서를 스캔해서 바로 올려요"
          onPress={() => {
            start('document', 'scan');
            router.push({ pathname: '/capture/camera', params: { mode: 'scan' } });
          }}
        />
      </Sheet>
      <Sheet open={sheet === 'more'} onClose={() => setSheet(null)}>
        <Group>
          <Row
            icon={Share2}
            onPress={() => {
              setSheet(null);
              router.push({ pathname: '/note-share', params: { folderId: id } });
            }}
          >
            폴더 자료 공유하기
          </Row>
          <Row
            icon={Trash2}
            danger
            onPress={() => {
              setSheet(null);
              setConfirmDelete(true);
            }}
          >
            폴더 삭제
          </Row>
        </Group>
      </Sheet>
      <Alert
        open={confirmDelete}
        title="폴더를 삭제할까요?"
        body={`${folder?.title ?? '이 폴더'}를 삭제하면 복구할 수 없어요.`}
        secondary="취소"
        onSecondary={() => setConfirmDelete(false)}
        primary="삭제"
        onPrimary={() => {
          setConfirmDelete(false);
          del.mutate();
        }}
      />
    </Canvas>
  );
}

const UploadOpt = ({
  icon: Icon,
  title,
  sub,
  onPress,
}: {
  icon: LucideIcon;
  title: string;
  sub: string;
  onPress: () => void;
}) => (
  <Animated.View entering={FadeIn}>
    <Card onPress={onPress} className="mb-2 flex-row items-center gap-3 px-4 py-3.5">
      <View className="h-10 w-10 items-center justify-center rounded-xl bg-white">
        <Icon size={ICON.md} color={C.brand} />
      </View>
      <View className="flex-1">
        <Text className="text-subhead font-semibold text-ink">{title}</Text>
        <Text className="text-caption text-sub">{sub}</Text>
      </View>
      <ChevronRight size={ICON.sm} color={C.sub} />
    </Card>
  </Animated.View>
);
