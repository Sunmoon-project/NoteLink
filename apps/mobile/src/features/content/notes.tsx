import { useTour, useTourTarget } from '@/features/tutor/tour';
import { InterestPicker } from '@/features/profile/interest-picker';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Pressable } from '@/components/press';
import { Text } from '@/components/text';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { router, useLocalSearchParams } from 'expo-router';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  RotateCcw,
  ScanLine,
  Share2,
  Trash2,
  X,
} from 'lucide-react-native';
import type { Material, QuizSet } from '@notelink/shared';
import { api, ApiError } from '@/lib/api';
import { toast } from '@/stores/toast';
import { useQuizProgress } from '@/stores/quiz-progress';
import { useDraft } from '@/stores/draft';
import { retryingIn, useRetrying } from '@/stores/retrying';
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
  SwipeAction,
  Tap,
  Title,
  cx,
  BACKDROP_IN,
  BACKDROP_OUT,
  FADE_IN,
  popInFrom,
} from '@/components/ui';
import { NetBanner } from '@/components/NetBanner';
import { useTabRefresh } from '@/hooks';
import { C, ICON, MOTION } from '@/theme';
import { seoul } from '@/lib/dates';

// p.58~60 노트 목록 · 새 자료 · 강의 상세 · 올리기 방식 선택

const TAGS = ['수학', '영어', '국어', '과학', '사회', '자격증', '기타'];

/**
 * 폴더를 지우면 서버가 그 폴더의 퀴즈 세트 · 플래시카드 · 보관함 문제도 지우므로(#602) 퀴즈 탭이 쓰는 캐시도 새로 읽게 한다
 */
const FOLDER_DELETE_KEYS = [
  'folders',
  'quiz-sets',
  'quiz-set',
  'flashcards',
  'quiz-box',
  'today-review',
] as const;
const refreshAfterFolderDelete = (qc: QueryClient, folderId: string) => {
  void dropDeletedProgress(qc, folderId);
  for (const key of FOLDER_DELETE_KEYS) void qc.invalidateQueries({ queryKey: [key] });
};

/**
 * 풀던 퀴즈가 지운 폴더의 세트면 진행도 지운다: 퀴즈 홈의 「이어서 풀기」가 지운 세트를 가리키지 않게(code-review 3차).
 * 오늘의 복습 · 거기서 이어 만든 오답 복습은 서버가 남기므로(여러 폴더 문제를 섞음) 진행도 남긴다. 캐시로 원본까지 거슬러
 * 오를 수 있을 때만 캐시로 정하고, 모르면 서버에 그 세트가 남았는지 물어 404일 때만 지운다(Codex 1차)
 */
async function dropDeletedProgress(qc: QueryClient, folderId: string) {
  const progress = useQuizProgress.getState().progress;
  if (!progress) return;
  const list = qc.getQueryData<QuizSet[]>(['quiz-sets']) ?? [];
  const find = (id: string) =>
    qc.getQueryData<QuizSet>(['quiz-set', id]) ?? list.find((s) => s._id === id);
  const set = find(progress.setId);
  if (set && set.folderId !== folderId) return;
  const seen = new Set<string>();
  let cur = set;
  while (cur && !cur.reviewDay && cur.sourceSetId && !seen.has(cur.sourceSetId)) {
    seen.add(cur.sourceSetId);
    cur = find(cur.sourceSetId);
  }
  if (cur?.reviewDay) return;
  const gone =
    set && cur && !cur.sourceSetId
      ? true
      : await api.quiz.set(progress.setId).then(
          () => false,
          (e: unknown) => e instanceof ApiError && e.status === 404,
        );
  if (gone && useQuizProgress.getState().progress?.setId === progress.setId)
    useQuizProgress.getState().reset();
}
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
  // 폴더를 꾹 누르면 삭제 확인(폴더 안 ⋯ 메뉴와 같은 삭제)
  const qc = useQueryClient();
  const [removing, setRemoving] = useState<{ _id: string; title: string } | null>(null);
  const delFolder = useMutation({
    mutationFn: (folderId: string) => api.content.deleteFolder(folderId),
    onSuccess: (_, folderId) => {
      refreshAfterFolderDelete(qc, folderId);
      toast('폴더를 삭제했어요');
    },
    onError: () => toast('폴더를 삭제하지 못했어요. 다시 시도해 주세요'),
  });

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
                  onLongPress={() => setRemoving(f)}
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
      <Alert
        open={!!removing}
        title="폴더를 삭제할까요?"
        body={`${removing?.title ?? '이 폴더'}를 삭제하면 복구할 수 없어요.`}
        secondary="취소"
        onSecondary={() => setRemoving(null)}
        primary="삭제"
        onPrimary={() => {
          if (removing) delFolder.mutate(removing._id);
          setRemoving(null);
        }}
      />
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
  // 관심 분야 고르기(가입 · 프로필)와 같은 목록 · 칩을 쓴다. 고른 분야 이름이 폴더의 과목(subjectName)이 된다
  const categories = useQuery({
    queryKey: ['interest-categories'],
    queryFn: api.me.interestCategories,
  });
  // 목록을 못 받으면 예전 기본 과목으로 고른다
  const list = categories.data?.length
    ? categories.data
    : categories.isError
      ? TAGS.map((name) => ({ _id: name, name, parentId: null }))
      : [];
  const [picked, setPicked] = useState<string | null>(null);
  const tag = list.find((c) => c._id === picked)?.name;
  return (
    <Canvas>
      <Screen
        footer={
          <Btn
            disabled={!tag}
            onPress={() => router.push({ pathname: '/note-new/title', params: { tag } })}
          >
            다음
          </Btn>
        }
      >
        <Header title="태그 설정" right={<Steps n={0} />} />
        <Text className="mt-4 mb-1 text-subhead font-semibold text-ink">과목을 선택해주세요</Text>
        {categories.isPending && <Text className="text-caption text-sub">불러오는 중이에요</Text>}
        {/* 한 폴더에 과목은 하나: 다른 칩을 누르면 바꾸고, 고른 칩을 다시 누르면 풀린다 */}
        <InterestPicker
          categories={list}
          selected={picked ? [picked] : []}
          onToggle={(id) => setPicked((p) => (p === id ? null : id))}
        />
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

/** 정리 중(대기 queued · 처리 중)인 자료가 있으면 3초마다 목록을 다시 읽는다. 모두 끝났으면 멈춘다 */
export const materialsPollMs = (list: Material[] | undefined) =>
  list?.some((m) => m.processing?.status === 'queued' || m.processing?.status === 'processing')
    ? 3000
    : false;

/** 정리 중으로 보이게 바꾼 자료(다시 요약을 넣었는데 아직 그 상태를 읽지 못함) */
const asQueued = (m: Material): Material => ({
  ...m,
  processing: { ...m.processing, status: 'queued', progress: 0 },
});

/**
 * 폴더 자료 목록을 읽는다. 다시 요약한 자료(useRetrying)는 목록 값 대신 그 자료만 따로 읽는다(서버가 이 자료의 작업 상태를
 * 맞춘다). 목록은 한 번에 일부 자료만 작업 상태를 맞춰, 실패한 자료가 많으면 다시 넣은 자료가 계속 실패로 보이고
 * 다시 읽기도 멈췄다(Codex #520 리뷰). 끝나면(done · failed) 또는 목록에서 없어지면 추적을 풀고, 읽지 못하면 정리 중으로
 * 둔 채 다음에 다시 읽는다. 추적은 폴더별 store에 있어 화면을 닫았다 열어도 이어진다(5차 리뷰)
 */
export async function readFolderMaterials(
  folderId: string,
  signal?: AbortSignal,
): Promise<Material[]> {
  const list = await api.content.materials(folderId);
  const retrying = retryingIn(folderId);
  if (!retrying.length) return list;
  const seen = new Set(list.map((m) => m._id));
  const ended = retrying.filter((mid) => !seen.has(mid));
  const out = await Promise.all(
    list.map(async (m) => {
      if (!retrying.includes(m._id)) return m;
      try {
        const fresh = await api.content.material(m._id);
        if (fresh.processing.status === 'done' || fresh.processing.status === 'failed')
          ended.push(m._id);
        return fresh;
      } catch {
        return asQueued(m);
      }
    }),
  );
  // 취소된 읽기(다시 요약 직후 invalidate 등)는 결과가 버려지므로, 그 사이 새로 넣은 추적을 풀지 않는다
  if (ended.length && !signal?.aborted) useRetrying.getState().untrack(folderId, ended);
  return out;
}

export function FolderScreen() {
  // 첫 폴더 안내가 짚는 + 버튼
  const addTarget = useTourTarget('folder-add');
  const { id, upload } = useLocalSearchParams<{ id: string; upload?: 'hand' | 'rec' | 'doc' }>();
  const qc = useQueryClient();
  const folders = useQuery({ queryKey: ['folders'], queryFn: api.content.folders });
  const folder = folders.data?.find((f) => f._id === id);
  const mats = useQuery({
    queryKey: ['materials', id],
    queryFn: ({ signal }) => readFolderMaterials(id, signal),
    // 정리 중인 자료가 있으면(다시 요약 포함) 끝날 때까지 다시 읽어 진행 표시 · 다시 요약 버튼을 바로잡는다(Codex #519 리뷰)
    refetchInterval: (q) => (retryingIn(id).length ? 3000 : materialsPollMs(q.state.data)),
  });
  // 서버에 폴더 자료 목록 경로가 아직 없을 때(404) 폴더 목록이 센 자료가 0개면 실패가 아니라 빈 폴더다.
  // 자료가 있다고 세었는데 목록을 못 읽으면 지금처럼 실패를 보여 준다(지운 폴더는 목록에 없어 여기도 실패).
  // 앞서 받아 둔 자료 목록이 있으면 다시 읽기가 404여도 그 목록을 그대로 보여 준다(빈 폴더로 덮지 않음)
  const emptyFolder =
    !mats.data &&
    (mats.error as { status?: number } | null)?.status === 404 &&
    folder?.materialCount === 0;
  const [filter, setFilter] = useState('전체');
  const [dial, setDial] = useState(false);
  const [sheet, setSheet] = useState<null | 'hand' | 'rec' | 'doc' | 'more'>(upload ?? null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // 왼쪽으로 밀어 지울 자료(확인 대화상자를 거친다)
  const [removing, setRemoving] = useState<Material | null>(null);
  const delMaterial = useMutation({
    mutationFn: (m: Material) => api.content.deleteMaterial(m._id),
    onSuccess: (_, m) => {
      qc.setQueryData<Material[]>(['materials', id], (list) =>
        list?.filter((x) => x._id !== m._id),
      );
      void qc.invalidateQueries({ queryKey: ['materials', id] });
      void qc.invalidateQueries({ queryKey: ['folders'] });
      toast('자료를 삭제했어요');
    },
    onError: () => toast('삭제하지 못했어요. 다시 시도해 주세요'),
  });
  const draft = useDraft();
  const del = useMutation({
    mutationFn: () => api.content.deleteFolder(id),
    onSuccess: () => {
      refreshAfterFolderDelete(qc, id);
      router.back();
      toast('폴더를 삭제했어요');
    },
  });

  const items = (mats.data ?? []).filter((m) => filter === '전체' || KIND[m.kind][1] === filter);
  // 요약에 실패한 자료마다 「다시 요약」: 그 자료의 정리 작업을 다시 넣는다(서버가 자료 상태도 함께 되돌린다)
  const resummarize = useMutation({
    mutationFn: (m: Material) => api.ai.retry(m.processing.jobId!),
    onSuccess: (_job, m) => {
      // 바로 정리 중으로 보이고, 끝날 때까지 이 자료는 따로 읽는다(readFolderMaterials)
      useRetrying.getState().track(id, m._id);
      qc.setQueryData<Material[]>(['materials', id], (list) =>
        list?.map((x) => (x._id === m._id ? asQueued(x) : x)),
      );
      void qc.invalidateQueries({ queryKey: ['materials'] });
      toast('다시 요약하고 있어요. 끝나면 알려 드릴게요');
    },
    onError: (e) =>
      toast(e instanceof ApiError ? e.message : '다시 요약하지 못했어요. 잠시 뒤 다시 눌러 주세요'),
  });
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
        {mats.isError && !mats.data && !emptyFolder && (
          <View className="items-center gap-3 py-12">
            <Text className="text-footnote text-sub">자료를 불러오지 못했어요</Text>
            <Btn small onPress={() => void mats.refetch()}>
              자료 다시 시도
            </Btn>
          </View>
        )}
        {emptyFolder || (mats.isSuccess && mats.data.length === 0) ? (
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
                    <SwipeAction label="삭제" name={m.title} onAction={() => setRemoving(m)}>
                      <Tap
                        scaleTo={0.99}
                        onPress={() => open(m)}
                        className="flex-row items-center gap-3.5 bg-white px-5 py-4"
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
                            {m.kind === 'recording' && st !== 'failed' && ` · ${summaryState(m)}`}
                            {st === 'failed' && <Text className="text-danger"> · 요약 실패</Text>}
                          </Text>
                        </View>
                        {/* AI가 아직 처리 중인 자료는 화살표 대신 진행 표시, 요약에 실패한 자료는 다시 요약 */}
                        {busy ? (
                          <ActivityIndicator size="small" color={C.brand} />
                        ) : st === 'failed' && m.processing.jobId ? (
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`${m.title} 다시 요약`}
                            hitSlop={8}
                            disabled={resummarize.isPending}
                            onPress={() => resummarize.mutate(m)}
                            className="flex-row items-center gap-1 rounded-full bg-mint px-3 py-1.5"
                          >
                            {resummarize.isPending && resummarize.variables?._id === m._id ? (
                              <ActivityIndicator size="small" color={C.brand} />
                            ) : (
                              <RotateCcw size={ICON.xs} color={C.brand} />
                            )}
                            <Text className="text-caption font-semibold text-brand">다시 요약</Text>
                          </Pressable>
                        ) : (
                          <ChevronRight size={ICON.sm} color={C.sub} />
                        )}
                      </Tap>
                    </SwipeAction>
                  </Animated.View>
                );
              })}
            </View>
          </>
        )}
      </Screen>

      {dial && (
        <Animated.View
          entering={BACKDROP_IN}
          exiting={BACKDROP_OUT}
          className="absolute inset-0 z-20"
        >
          <Pressable className="absolute inset-0 bg-black/45" onPress={() => setDial(false)} />
          <View className="absolute right-5 bottom-24 items-end gap-3">
            {(
              [
                ['doc', '학습 자료 올리기', FileText],
                ['rec', '녹음 올리기 · 실시간 녹음', Mic],
                ['hand', '필기 올리기', PenLine],
              ] as const
            ).map(([k, l, Ic], i, all) => (
              <Animated.View key={k} entering={popInFrom(all.length - 1 - i)}>
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
        </Animated.View>
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
      <Alert
        open={!!removing}
        title="자료를 삭제할까요?"
        body={`${removing?.title ?? '이 자료'}를 삭제하면 복구할 수 없어요.`}
        secondary="취소"
        onSecondary={() => setRemoving(null)}
        primary="삭제"
        onPrimary={() => {
          if (removing) delMaterial.mutate(removing);
          setRemoving(null);
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
  <Animated.View entering={FADE_IN}>
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
