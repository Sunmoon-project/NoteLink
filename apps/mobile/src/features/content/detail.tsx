import { useState } from 'react';
import { Image as RNImage, Linking, Pressable, ScrollView, View } from 'react-native';
import { Text, TextInput } from '@/components/text';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import {
  Bold,
  Check,
  FileText,
  Folder,
  Heading1,
  ImageIcon,
  Link2,
  List,
  MoreHorizontal,
  Pencil,
  Share2,
  Trash2,
  Users,
} from 'lucide-react-native';
import type { Material } from '@notelink/shared';
import { api } from '@/lib/api';
import { toast } from '@/stores/toast';
import { AiPending } from '@/components/AiPending';
import {
  Badge,
  Btn,
  Canvas,
  Card,
  Dialog,
  Group,
  Header,
  Label,
  Loading,
  Pie,
  Row,
  Screen,
  Segment,
  Sheet,
  Success,
  Two,
  cx,
} from '@/components/ui';
import { C, ICON } from '@/theme';
import { DocSummary, NoteBody } from './convert';
import { Player } from './player';
import { TutorBuddy, useTuckOnScroll } from '@/features/tutor/buddy';
import { seoul } from '@/lib/dates';

// p.67~73 필기 · 녹음 · 문서 상세 / 편집 / 다운로드 / 공유 / 삭제

/** 아바타가 설명할 글이 있는 노트: 정리가 끝났거나 요약 · 쪽 글이 있음(서버 NOTE_NOT_READY 전에 숨김) */
const canAsk = (m: Material) =>
  m.processing?.status === 'done' ||
  !!m.summary?.sections.length ||
  !!m.summary?.points.length ||
  !!m.pages?.some((p) => p.ocrText?.trim());

function useMaterial() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useQuery({ queryKey: ['material', id], queryFn: () => api.content.material(id) });
  // 이미 불러온 자료가 있으면 재조회 실패로 화면을 지우지 않는다
  return { id, m: q.data, isError: q.isError && !q.data, error: q.error, refetch: q.refetch };
}

function MaterialError({ retry }: { retry: () => unknown }) {
  return (
    <Canvas>
      <Screen>
        <Header title="자료 조회" />
        <Text>자료를 불러오지 못했어요. 삭제되었거나 연결을 확인해야 할 수 있어요.</Text>
        <Btn
          onPress={() => {
            void retry();
          }}
        >
          다시 시도
        </Btn>
        <Btn kind="outline" onPress={() => router.back()}>
          뒤로
        </Btn>
      </Screen>
    </Canvas>
  );
}

function OriginalFile({ m }: { m: Material }) {
  const [busy, setBusy] = useState(false);
  const open = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await openOriginal(m._id);
    } catch {
      toast('원본 파일을 열지 못했어요. 다시 시도해 주세요');
    } finally {
      setBusy(false);
    }
  };
  return (
    <View>
      <Btn loading={busy} onPress={open}>
        원본 파일 열기
      </Btn>
    </View>
  );
}

/** 자료가 든 폴더의 과목 이름 */
function useSubject(folderId?: string) {
  const folders = useQuery({ queryKey: ['folders'], queryFn: api.content.folders });
  return folders.data?.find((f) => f._id === folderId)?.subjectName;
}

const mb = (bytes: number) => (bytes > 0 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : '');

/** 원본 파일을 시스템 미리보기 · 공유 시트로 연다 (파일 앱에 저장 · 다른 앱으로 열기) */
async function openOriginal(id: string) {
  const { url } = await api.content.downloadUrl(id);
  if (url.startsWith('file://') && (await Sharing.isAvailableAsync()))
    return Sharing.shareAsync(url);
  if (!/^https?:\/\//i.test(url)) throw new Error('원본 주소가 없어요');
  await Linking.openURL(url);
}

/** 원본 페이지 이미지 — 두 손가락으로 확대 (FR-25-02) */
function PageImages({ pages }: { pages: NonNullable<Material['pages']> }) {
  if (!pages.length)
    return <Text className="mt-4 text-center text-footnote text-sub">원본 이미지가 없어요</Text>;
  return (
    <View className="gap-3">
      {pages.map((p) => (
        <View key={p.pageNo} className="overflow-hidden rounded-card bg-white">
          <ScrollView
            maximumZoomScale={4}
            minimumZoomScale={1}
            centerContent
            showsHorizontalScrollIndicator={false}
            showsVerticalScrollIndicator={false}
          >
            <RNImage
              source={{ uri: p.imageUrl }}
              accessibilityLabel={`${p.pageNo}페이지 원본`}
              className="aspect-[3/4] w-full"
              resizeMode="contain"
            />
          </ScrollView>
          <Text className="px-3 py-2 text-caption text-sub">
            {p.pageNo}페이지{p.sizeBytes ? ` · ${mb(p.sizeBytes)}` : ''}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** ⋯ 옵션 → 편집 · 공유 · 삭제 (p.72~73) */
function FileOptions({ m, open, onClose }: { m: Material; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [stage, setStage] = useState<null | 'confirm' | 'deleting' | 'done'>(null);
  const del = useMutation({
    mutationFn: () => api.content.deleteMaterial(m._id),
    onMutate: () => setStage('deleting'),
    onSuccess: () => setStage('done'),
    onError: () => {
      setStage(null);
      toast('삭제하지 못했어요. 다시 시도해 주세요');
    },
  });
  const finish = () => {
    qc.invalidateQueries({ queryKey: ['materials', m.folderId] });
    qc.invalidateQueries({ queryKey: ['folders'] });
    setStage(null);
    router.back();
  };
  return (
    <>
      <Sheet open={open} onClose={onClose}>
        <View className="items-start gap-2">
          <Pressable
            onPress={() => {
              onClose();
              router.push({ pathname: '/edit/[id]', params: { id: m._id } });
            }}
            className="h-11 flex-row items-center gap-2 rounded-full bg-fill px-4"
          >
            <Pencil size={ICON.sm} color={C.ink} />
            <Text className="text-subhead text-ink">편집하기</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              onClose();
              router.push({ pathname: '/note-share', params: { id: m._id } });
            }}
            className="h-11 flex-row items-center gap-2 rounded-full bg-fill px-4"
          >
            <Share2 size={ICON.sm} color={C.ink} />
            <Text className="text-subhead text-ink">공유하기</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              onClose();
              setStage('confirm');
            }}
            className="h-11 flex-row items-center gap-2 rounded-full bg-fill px-4"
          >
            <Trash2 size={ICON.sm} color={C.danger} />
            <Text className="text-subhead text-danger">삭제하기</Text>
          </Pressable>
        </View>
        <Btn kind="cream" className="mt-5" onPress={onClose}>
          취소
        </Btn>
      </Sheet>
      <Dialog open={stage === 'confirm'} onClose={() => setStage(null)}>
        <Text className="text-body font-bold text-ink">삭제하시겠습니까?</Text>
        <Text className="mt-1 text-caption text-sub">삭제한 자료는 복구할 수 없어요</Text>
        <View className="mt-5 w-full">
          <Two>
            <Btn small kind="outline" onPress={() => setStage(null)}>
              아니오
            </Btn>
            <Btn small kind="danger" onPress={() => del.mutate()}>
              예
            </Btn>
          </Two>
        </View>
      </Dialog>
      <Dialog open={stage === 'deleting'}>
        <Pie value={70} size={44} color={C.danger} />
        <Text className="mt-3 text-callout font-bold text-ink">삭제하고 있어요...</Text>
        <Text className="text-caption text-sub">잠시만 기다려주세요</Text>
      </Dialog>
      <Dialog open={stage === 'done'}>
        <View className="h-12 w-12 items-center justify-center rounded-full bg-mint">
          <Check size={ICON.lg} color={C.brand} />
        </View>
        <Text className="mt-3 text-callout font-bold text-ink">삭제가 완료됐어요</Text>
        <Text className="text-caption text-sub">{m.title} 파일이 삭제됐어요</Text>
        <Btn small className="mt-4 w-full" onPress={finish}>
          확인
        </Btn>
      </Dialog>
    </>
  );
}

const More = ({ onPress }: { onPress: () => void }) => (
  <Pressable
    accessibilityLabel="파일 옵션"
    onPress={onPress}
    className="h-11 w-11 items-center justify-center rounded-full bg-white"
  >
    <MoreHorizontal size={ICON.md} color={C.ink} />
  </Pressable>
);
const dateLabel = (m: Material, kind: string) =>
  `${kind} · ${seoul(m.createdAt).getMonth() + 1}/${seoul(m.createdAt).getDate()} 업로드`;

export function HandDetailScreen() {
  const { tab: t } = useLocalSearchParams<{ tab?: '정리된 노트' | '원본 이미지' }>();
  const { id, m, isError, refetch } = useMaterial();
  const [tab, setTab] = useState<'정리된 노트' | '원본 이미지'>(t ?? '정리된 노트');
  const [opt, setOpt] = useState(false);
  const subject = useSubject(m?.folderId);
  const buddy = useTuckOnScroll();
  if (isError) return <MaterialError retry={refetch} />;
  if (!m) return <Loading />;
  return (
    <Canvas>
      <Screen
        onScroll={buddy.onScroll}
        overlay={canAsk(m) && <TutorBuddy id={id} tucked={buddy.tucked} />}
        footer={
          <Two>
            <Btn
              kind="outline"
              onPress={() => router.push({ pathname: '/note-share', params: { id } })}
            >
              공유하기
            </Btn>
            <Btn onPress={() => router.push({ pathname: '/edit/[id]', params: { id } })}>
              편집하기
            </Btn>
          </Two>
        }
      >
        <Header
          title={m.title}
          sub={dateLabel(m, '필기')}
          large={false}
          right={<More onPress={() => setOpt(true)} />}
        />
        <Segment items={['정리된 노트', '원본 이미지'] as const} value={tab} onChange={setTab} />
        <View className="mt-4">
          {tab === '정리된 노트' ? (
            m.summary?.sections.length ? (
              <NoteBody sections={m.summary.sections} />
            ) : (
              <AiPending what="필기 정리" hint="직접 정리하려면 '편집하기'를 눌러 써 보세요." />
            )
          ) : (
            <View className="gap-3">
              {!!m.pages?.length && <PageImages pages={m.pages} />}
              <OriginalFile m={m} />
            </View>
          )}
        </View>
        {subject && (
          <>
            <Label>과목</Label>
            <Badge>{subject}</Badge>
          </>
        )}
      </Screen>
      <FileOptions m={m} open={opt} onClose={() => setOpt(false)} />
    </Canvas>
  );
}

const Toolbar = () => (
  <View className="flex-row items-center justify-center gap-6 rounded-xl bg-white py-3">
    {[Bold, Heading1, List, ImageIcon, Link2].map((I, i) => (
      <I key={i} size={ICON.sm} color={C.ink} />
    ))}
  </View>
);

export function EditScreen() {
  const { id, m, isError, refetch } = useMaterial();
  const qc = useQueryClient();
  const [sections, setSections] = useState<{ heading: string; body: string }[]>([]);
  const [editing, setEditing] = useState(false);
  // 자료를 처음 불러왔을 때만 편집할 본문을 채운다 — 재조회가 고치던 글을 덮어쓰지 않게 (렌더 중 상태 조정)
  const [loaded, setLoaded] = useState<string>();
  if (m && m._id !== loaded) {
    setLoaded(m._id);
    setSections((m.summary?.sections ?? []).map((section) => ({ ...section })));
  }
  const save = useMutation({
    mutationFn: () => {
      if (!m || loaded !== id) throw new Error('자료를 먼저 불러와 주세요');
      // 아무것도 쓰지 않은 섹션은 저장하지 않는다
      return api.content.updateSummary(
        id,
        sections.filter((s) => s.heading.trim() || s.body.trim()),
      );
    },
    onError: () => toast('노트를 저장하지 못했어요. 다시 시도해주세요'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['material', id] });
      router.back();
      toast('노트를 저장했어요');
    },
  });
  if (isError) return <MaterialError retry={refetch} />;
  return (
    <Canvas>
      <Screen
        footer={
          !editing && (
            <>
              <Toolbar />
              <View className="mt-3">
                <Two>
                  <Btn kind="outline" onPress={() => router.back()}>
                    취소
                  </Btn>
                  <Btn
                    disabled={!m || loaded !== id}
                    loading={save.isPending}
                    onPress={() => save.mutate()}
                  >
                    저장
                  </Btn>
                </Two>
              </View>
            </>
          )
        }
      >
        <Header
          title="노트 편집"
          large={false}
          right={
            <Pressable
              disabled={!m || loaded !== id || save.isPending}
              onPress={() => save.mutate()}
              className={cx(
                'rounded-full px-3 py-1',
                editing ? 'bg-brand' : 'border border-brand/40',
              )}
            >
              <Text
                className={cx('text-footnote font-semibold', editing ? 'text-white' : 'text-brand')}
              >
                저장
              </Text>
            </Pressable>
          }
        />
        <View className="-mt-2 mb-3 flex-row items-center gap-1">
          <Text className="text-caption2 text-sub">필기 · 업로드 · 수정 중</Text>
          {editing && <Badge tone="danger">● 편집 중</Badge>}
        </View>
        <View className="relative rounded-card border-2 border-brand/30 bg-white p-5">
          <View className="absolute top-3 right-3 h-6 w-6 items-center justify-center rounded-full bg-blue">
            <Pencil size={ICON.xs} color="#fff" />
          </View>
          {sections.map((section, index) => (
            <View key={index}>
              <TextInput
                accessibilityLabel={`섹션 ${index + 1} 제목`}
                placeholder="섹션 제목"
                placeholderTextColor={C.sub}
                value={section.heading}
                onChangeText={(heading) =>
                  setSections((all) => all.map((s, i) => (i === index ? { ...s, heading } : s)))
                }
                onFocus={() => setEditing(true)}
                onBlur={() => setEditing(false)}
              />
              <TextInput
                accessibilityLabel={index === 0 ? '노트 내용' : `섹션 ${index + 1} 본문`}
                multiline
                placeholder="내용을 입력하세요"
                placeholderTextColor={C.sub}
                value={section.body}
                onChangeText={(body) =>
                  setSections((all) => all.map((s, i) => (i === index ? { ...s, body } : s)))
                }
                onFocus={() => setEditing(true)}
                onBlur={() => setEditing(false)}
                className="min-h-32 text-footnote leading-5 text-ink"
                style={{ textAlignVertical: 'top' }}
              />
            </View>
          ))}
        </View>
        <Pressable
          onPress={() => setSections((s) => [...s, { heading: '', body: '' }])}
          className="mt-3 self-start rounded-full border border-brand/40 px-3 py-1"
        >
          <Text className="text-caption text-brand">+ 섹션 추가</Text>
        </Pressable>
        {editing && (
          <View className="mt-4">
            <Toolbar />
          </View>
        )}
      </Screen>
    </Canvas>
  );
}

export function RecDetailScreen() {
  const { view, bookmarks } = useLocalSearchParams<{ view?: 'text'; bookmarks?: string }>();
  const { id, m, isError, refetch } = useMaterial();
  const [opt, setOpt] = useState(false);
  const subject = useSubject(m?.folderId);
  const buddy = useTuckOnScroll();
  if (isError) return <MaterialError retry={refetch} />;
  if (!m) return <Loading />;
  return (
    <Canvas>
      <Screen
        onScroll={buddy.onScroll}
        overlay={canAsk(m) && <TutorBuddy id={id} tucked={buddy.tucked} />}
      >
        <Header
          title={view === 'text' ? '원문 텍스트 보기' : m.title}
          sub={dateLabel(m, '녹음')}
          large={false}
          right={<More onPress={() => setOpt(true)} />}
        />
        <View className="-mt-2 mb-3 flex-row items-center gap-2">
          {view === 'text' && <Text className="text-caption text-sub">{m.title}</Text>}
          {subject && <Badge>{subject}</Badge>}
          {m.description ? (
            <Text className="flex-1 text-caption text-sub">{m.description}</Text>
          ) : null}
        </View>
        <Player
          materialId={id}
          initialView={view === 'text' ? 'text' : 'summary'}
          openBookmarks={!!bookmarks}
        />
      </Screen>
      <FileOptions m={m} open={opt} onClose={() => setOpt(false)} />
    </Canvas>
  );
}

export function DocDetailScreen() {
  const { tab: t } = useLocalSearchParams<{ tab?: '요약' | '원본 문서' }>();
  const { id, m, isError, refetch } = useMaterial();
  const [tab, setTab] = useState<'요약' | '원본 문서'>(t ?? '요약');
  const [opt, setOpt] = useState(false);
  const subject = useSubject(m?.folderId);
  const buddy = useTuckOnScroll();
  const download = useMutation({
    mutationFn: async () => {
      const { url, fileName } = await api.content.downloadUrl(id);
      // 기기에 있는 원본은 바로 공유 시트로 → '파일에 저장'
      if (url.startsWith('file://')) {
        await openOriginal(id);
        return fileName;
      }
      // Blob에서 받아 기기에 저장 → 공유 시트에서 "파일에 저장" 선택
      const dir = new Directory(Paths.document, 'downloads');
      if (!dir.exists) dir.create();
      const out = await File.downloadFileAsync(url, dir);
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(out.uri);
      return fileName;
    },
    onSuccess: (fileName) => router.push({ pathname: '/downloaded', params: { name: fileName } }),
    onError: () => toast('다운로드하지 못했어요. 연결을 확인해 주세요'),
  });
  if (isError) return <MaterialError retry={refetch} />;
  if (!m) return <Loading />;
  return (
    <Canvas>
      <Screen
        onScroll={buddy.onScroll}
        overlay={canAsk(m) && <TutorBuddy id={id} tucked={buddy.tucked} />}
        footer={
          <Two>
            <Btn
              kind="outline"
              onPress={() => router.push({ pathname: '/note-share', params: { id } })}
            >
              공유하기
            </Btn>
            <Btn loading={download.isPending} onPress={() => download.mutate()}>
              다운로드
            </Btn>
          </Two>
        }
      >
        <Header
          title={m.title}
          sub={`${dateLabel(m, '문서')}${m.pages?.length ? ` · ${m.pages.length}페이지` : ''}`}
          large={false}
          right={<More onPress={() => setOpt(true)} />}
        />
        <Segment items={['요약', '원본 문서'] as const} value={tab} onChange={setTab} />
        {tab === '요약' ? (
          <View className="mt-4">
            {m.summary?.points.length ? (
              <DocSummary points={m.summary.points} keywords={m.keywords} />
            ) : (
              <AiPending what="문서 요약" />
            )}
            {subject && (
              <>
                <Label>과목</Label>
                <Badge>{subject}</Badge>
              </>
            )}
          </View>
        ) : (
          <View className="mt-4 gap-3">
            {!!m.pages?.length && <PageImages pages={m.pages} />}
            <OriginalFile m={m} />
          </View>
        )}
      </Screen>
      <FileOptions m={m} open={opt} onClose={() => setOpt(false)} />
    </Canvas>
  );
}

export function DownloadedScreen() {
  const { name } = useLocalSearchParams<{ name?: string }>();
  return (
    <Canvas>
      <Screen footer={<Btn onPress={() => router.back()}>확인</Btn>}>
        <Success
          title="다운로드가 완료됐어요!"
          body={
            name ? `${name} 파일이 다운로드 폴더에 저장됐어요` : '파일이 다운로드 폴더에 저장됐어요'
          }
          card={
            <Card className="flex-row items-center gap-3 p-3">
              <View className="h-10 w-10 items-center justify-center rounded-lg bg-mint">
                <FileText size={ICON.sm} color={C.sub} />
              </View>
              <View>
                <Text className="text-subhead font-semibold text-ink">
                  {name ?? '다운로드한 파일'}
                </Text>
                <View className="flex-row items-center gap-1.5">
                  <Folder size={ICON.xs} color={C.sub} />
                  <Text className="text-caption2 text-sub">다운로드 폴더에 저장됨</Text>
                </View>
              </View>
            </Card>
          }
        />
      </Screen>
    </Canvas>
  );
}

const TABS = { 필기: 'handwriting', 학습자료: 'document', 녹음본: 'recording' } as const;

export function ShareScreen() {
  const { id, folderId } = useLocalSearchParams<{ id?: string; folderId?: string }>();
  const material = useQuery({
    queryKey: ['material', id],
    queryFn: () => api.content.material(id!),
    enabled: !!id,
  });
  const folders = useQuery({ queryKey: ['folders'], queryFn: api.content.folders });
  const fid = folderId ?? material.data?.folderId ?? (!id ? folders.data?.[0]?._id : undefined);
  const mats = useQuery({
    queryKey: ['materials', fid],
    queryFn: () => api.content.materials(fid!),
    enabled: !!fid,
  });
  const rooms = useQuery({ queryKey: ['rooms', 'mine'], queryFn: api.rooms.mine });
  const friends = useQuery({ queryKey: ['friends'], queryFn: api.social.friends });
  const [tab, setTab] = useState<keyof typeof TABS>('필기');
  const [sel, setSel] = useState<string[]>(id ? [id] : []);
  const [loadedShare, setLoadedShare] = useState<string>();
  if (material.data && material.data._id === id && loadedShare !== material.data._id) {
    setLoadedShare(material.data._id);
    const initialTab = (Object.keys(TABS) as (keyof typeof TABS)[]).find(
      (key) => TABS[key] === material.data.kind,
    );
    if (initialTab) setTab(initialTab);
    setSel([material.data._id]);
  }
  const [to, setTo] = useState<{ type: 'room' | 'friend'; id: string; name: string } | null>(null);
  const [pick, setPick] = useState(false);
  const list = (mats.data ?? []).filter((m) => m.kind === TABS[tab]);
  const selected = list.filter((m) => sel.includes(m._id));
  const selectedIds = selected.map((m) => m._id);
  const share = useMutation({
    mutationFn: () => {
      if (!to || !targets.some((t) => t.type === to.type && t.id === to.id) || !selectedIds.length)
        throw new Error('공유 대상을 선택해주세요');
      return api.content.share({ materialIds: selectedIds, target: { type: to.type, id: to.id } });
    },
    onError: () => toast('공유하지 못했어요. 대상과 연결을 확인해주세요'),
    onSuccess: () =>
      router.replace({
        pathname: '/note-shared',
        params: {
          to: to!.name,
          n: String(selectedIds.length),
          tab,
          name: selected[0]?.title,
        },
      }),
  });
  const targets = [
    ...(rooms.data ?? []).map((r) => ({ type: 'room' as const, id: r._id, name: r.title })),
    ...(friends.data ?? []).map((f) => ({
      type: 'friend' as const,
      id: f.userId,
      name: `친구 · ${f.nickname}`,
    })),
  ];
  return (
    <Canvas>
      <Screen
        footer={
          <Btn
            disabled={
              !selectedIds.length ||
              !to ||
              !targets.some((t) => t.type === to.type && t.id === to.id)
            }
            loading={share.isPending}
            onPress={() => share.mutate()}
          >
            공유하기
          </Btn>
        }
      >
        <Header title="공유하기" large={false} />
        <Segment
          items={Object.keys(TABS) as (keyof typeof TABS)[]}
          value={tab}
          onChange={(next) => {
            setTab(next);
            setSel([]);
          }}
        />
        <View className="mt-3 gap-2">
          {mats.isError && !mats.data && (
            <View className="gap-2 py-3">
              <Text className="text-footnote text-sub">자료 목록을 불러오지 못했어요</Text>
              <Btn small onPress={() => void mats.refetch()}>
                자료 목록 다시 시도
              </Btn>
            </View>
          )}
          {mats.isSuccess && list.length === 0 && (
            <Text className="py-6 text-center text-footnote text-sub">
              공유할 {tab} 자료가 없어요
            </Text>
          )}
          {list.map((m) => {
            const on = sel.includes(m._id);
            return (
              <Pressable
                key={m._id}
                onPress={() => setSel((p) => (on ? p.filter((x) => x !== m._id) : [...p, m._id]))}
                className="flex-row items-center gap-3 rounded-xl bg-white px-4 py-4"
              >
                <View
                  className={cx(
                    'h-5 w-5 items-center justify-center rounded border',
                    on ? 'border-brand bg-brand' : 'border-sub/30 bg-white',
                  )}
                >
                  {on && <Check size={ICON.xs} color="#fff" />}
                </View>
                <Text className="text-subhead text-ink">{m.title}</Text>
              </Pressable>
            );
          })}
        </View>
        <Label>공유 대상</Label>
        <Pressable
          onPress={() => setPick(true)}
          className="h-10 flex-row items-center self-start rounded-full bg-white px-4"
        >
          <View className="flex-row items-center gap-1.5">
            <Users size={ICON.xs} color={C.brand} />
            <Text className="text-footnote text-ink">
              {to?.name ?? '공유 대상을 선택해주세요'} ⌄
            </Text>
          </View>
        </Pressable>
        <Sheet open={pick} onClose={() => setPick(false)} title="공유 대상">
          <Group>
            {targets.map((x) => (
              <Row
                key={x.type + x.id + x.name}
                onPress={() => {
                  setTo(x);
                  setPick(false);
                }}
                right={
                  to?.id === x.id && to?.type === x.type && <Check size={ICON.sm} color={C.brand} />
                }
              >
                {x.name}
              </Row>
            ))}
          </Group>
        </Sheet>
      </Screen>
    </Canvas>
  );
}

export function SharedScreen() {
  const {
    to,
    n = '1',
    tab = '자료',
    name,
  } = useLocalSearchParams<{ to?: string; n?: string; tab?: string; name?: string }>();
  return (
    <Canvas>
      <Screen
        footer={
          <>
            <Btn onPress={() => router.back()}>확인</Btn>
          </>
        }
      >
        <Success
          title="공유가 완료됐어요!"
          body={to ? `${to}에 ${tab} ${n}개를 공유했어요` : `${tab} ${n}개를 공유했어요`}
          card={
            <Card className="flex-row items-center gap-3 p-3">
              <View className="h-10 w-10 items-center justify-center rounded-lg bg-mint">
                <FileText size={ICON.sm} color={C.sub} />
              </View>
              <View>
                <Text className="text-subhead font-semibold text-ink">{name ?? '공유한 자료'}</Text>
                <View className="flex-row items-center gap-1.5">
                  <Users size={ICON.xs} color={C.sub} />
                  <Text className="text-caption2 text-sub">
                    {to ? `${to}으로 전송됨` : '전송됨'}
                  </Text>
                </View>
              </View>
            </Card>
          }
        />
      </Screen>
    </Canvas>
  );
}
