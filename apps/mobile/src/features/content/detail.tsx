import { useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
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
import { env } from '@/lib/env';
import { toast } from '@/stores/toast';
import {
  Badge,
  Btn,
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
import { seoul } from '@/lib/dates';

// p.67~73 필기 · 녹음 · 문서 상세 / 편집 / 다운로드 / 공유 / 삭제

function useMaterial() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useQuery({ queryKey: ['material', id], queryFn: () => api.content.material(id) });
  return { id, m: q.data, isError: q.isError, error: q.error, refetch: q.refetch };
}

function MaterialError({ retry }: { retry: () => unknown }) {
  return (
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
  );
}

function OriginalFile({ m }: { m: Material }) {
  const [busy, setBusy] = useState(false);
  const open = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { url } = await api.content.downloadUrl(m._id);
      if (!/^https?:\/\//i.test(url)) throw new Error('원본 주소가 없어요');
      await Linking.openURL(url);
    } catch {
      toast('원본 파일을 열지 못했어요. 다시 시도해 주세요');
    } finally {
      setBusy(false);
    }
  };
  return (
    <View>
      <Text>{m.title}</Text>
      <Btn loading={busy} onPress={open}>
        원본 파일 열기
      </Btn>
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
            className="h-11 flex-row items-center gap-2 rounded-full border border-line px-4"
          >
            <Pencil size={ICON.sm} color={C.ink} />
            <Text className="text-subhead text-ink">편집하기</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              onClose();
              router.push({ pathname: '/note-share', params: { id: m._id } });
            }}
            className="h-11 flex-row items-center gap-2 rounded-full border border-line px-4"
          >
            <Share2 size={ICON.sm} color={C.ink} />
            <Text className="text-subhead text-ink">공유하기</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              onClose();
              setStage('confirm');
            }}
            className="h-11 flex-row items-center gap-2 rounded-full border border-line px-4"
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
    className="h-9 w-9 items-center justify-center rounded-full border border-line"
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
  if (isError) return <MaterialError retry={refetch} />;
  if (!m) return <Loading />;
  return (
    <View className="flex-1">
      <Screen
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
            <NoteBody sections={m.summary?.sections ?? []} />
          ) : (
            <OriginalFile m={m} />
          )}
        </View>
        <Label>과목</Label>
        <Badge>수학</Badge>
      </Screen>
      <FileOptions m={m} open={opt} onClose={() => setOpt(false)} />
    </View>
  );
}

const Toolbar = () => (
  <View className="flex-row items-center justify-center gap-6 rounded-xl border border-line py-2.5">
    {[Bold, Heading1, List, ImageIcon, Link2].map((I, i) => (
      <I key={i} size={ICON.sm} color={C.ink} />
    ))}
  </View>
);

export function EditScreen() {
  const { id, m } = useMaterial();
  const qc = useQueryClient();
  const [sections, setSections] = useState<{ heading: string; body: string }[]>([]);
  const [editing, setEditing] = useState(false);
  const [tags, setTags] = useState(['수학']);
  // 자료를 처음 불러왔을 때만 편집할 본문을 채운다 — 재조회가 고치던 글을 덮어쓰지 않게 (렌더 중 상태 조정)
  const [loaded, setLoaded] = useState<string>();
  if (m && m._id !== loaded) {
    setLoaded(m._id);
    setSections((m.summary?.sections ?? []).map((section) => ({ ...section })));
  }
  const save = useMutation({
    mutationFn: () => {
      if (!m || loaded !== id) throw new Error('자료를 먼저 불러와 주세요');
      return api.content.updateSummary(id, sections);
    },
    onError: () => toast('노트를 저장하지 못했어요. 다시 시도해주세요'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['material', id] });
      router.back();
      toast('노트를 저장했어요');
    },
  });
  return (
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
      <View className="relative rounded-2xl border-2 border-brand/30 bg-cream p-4">
        <View className="absolute top-3 right-3 h-6 w-6 items-center justify-center rounded-full bg-blue">
          <Pencil size={ICON.xs} color="#fff" />
        </View>
        {sections.map((section, index) => (
          <View key={index}>
            <TextInput
              accessibilityLabel={`섹션 ${index + 1} 제목`}
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
        onPress={() =>
          setSections((s) => [...s, { heading: '새 섹션', body: '내용을 입력하세요' }])
        }
        className="mt-3 self-start rounded-full border border-brand/40 px-3 py-1"
      >
        <Text className="text-caption text-brand">+ 섹션 추가</Text>
      </Pressable>
      <Label>과목</Label>
      <View className="flex-row items-center gap-2">
        {tags.map((t) => (
          <Badge key={t}>{t}</Badge>
        ))}
        <Pressable
          accessibilityLabel="과목 추가"
          onPress={() => setTags((t) => (t.includes('과학') ? t : [...t, '과학']))}
          className="h-6 w-6 items-center justify-center rounded-full border border-brand/40"
        >
          <Text className="text-brand">+</Text>
        </Pressable>
      </View>
      {editing && (
        <View className="mt-4">
          <Toolbar />
        </View>
      )}
    </Screen>
  );
}

export function RecDetailScreen() {
  const { view, bookmarks } = useLocalSearchParams<{ view?: 'text'; bookmarks?: string }>();
  const { id, m, isError, refetch } = useMaterial();
  const [opt, setOpt] = useState(false);
  if (isError) return <MaterialError retry={refetch} />;
  if (!m) return <Loading />;
  return (
    <View className="flex-1">
      <Screen>
        <Header
          title={view === 'text' ? '원문 텍스트 보기' : '녹음 요약 정리'}
          large={false}
          right={<More onPress={() => setOpt(true)} />}
        />
        <View className="-mt-2 mb-3 flex-row items-center gap-2">
          <Badge>화학</Badge>
          <Text className="text-caption text-sub">이온화 에너지와 원자 반지름</Text>
        </View>
        <Player
          materialId={id}
          initialView={view === 'text' ? 'text' : 'summary'}
          openBookmarks={!!bookmarks}
        />
      </Screen>
      <FileOptions m={m} open={opt} onClose={() => setOpt(false)} />
    </View>
  );
}

export function DocDetailScreen() {
  const { tab: t } = useLocalSearchParams<{ tab?: '요약' | '원본 문서' }>();
  const { id, m, isError, refetch } = useMaterial();
  const [tab, setTab] = useState<'요약' | '원본 문서'>(t ?? '요약');
  const [opt, setOpt] = useState(false);
  const download = useMutation({
    mutationFn: async () => {
      const { url, fileName } = await api.content.downloadUrl(id);
      if (env.useMock) return fileName;
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
    <View className="flex-1">
      <Screen
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
          sub={`${dateLabel(m, '문서')} · 3페이지`}
          large={false}
          right={<More onPress={() => setOpt(true)} />}
        />
        <Segment items={['요약', '원본 문서'] as const} value={tab} onChange={setTab} />
        {tab === '요약' ? (
          <>
            <DocSummary points={m.summary?.points ?? []} keywords={m.keywords} />
            <Label>과목</Label>
            <Badge>수학</Badge>
          </>
        ) : (
          <OriginalFile m={m} />
        )}
      </Screen>
      <FileOptions m={m} open={opt} onClose={() => setOpt(false)} />
    </View>
  );
}

export function DownloadedScreen() {
  const { name = '연습문제.pdf' } = useLocalSearchParams<{ name?: string }>();
  return (
    <Screen footer={<Btn onPress={() => router.back()}>확인</Btn>}>
      <Success
        title="다운로드가 완료됐어요!"
        body={`${name} 파일이 다운로드 폴더에 저장됐어요`}
        card={
          <Card className="flex-row items-center gap-3 p-3">
            <View className="h-10 w-10 items-center justify-center rounded-lg bg-mint">
              <FileText size={ICON.sm} color={C.sub} />
            </View>
            <View>
              <Text className="text-subhead font-semibold text-ink">{name}</Text>
              <View className="flex-row items-center gap-1.5">
                <Folder size={ICON.xs} color={C.sub} />
                <Text className="text-caption2 text-sub">다운로드 폴더에 저장됨</Text>
              </View>
            </View>
          </Card>
        }
      />
    </Screen>
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
    <Screen
      footer={
        <Btn
          disabled={
            !selectedIds.length || !to || !targets.some((t) => t.type === to.type && t.id === to.id)
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
        {list.length === 0 && (
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
              className="flex-row items-center gap-3 rounded-xl bg-cream px-4 py-3.5"
            >
              <View
                className={cx(
                  'h-5 w-5 items-center justify-center rounded border',
                  on ? 'border-brand bg-brand' : 'border-cream-2 bg-white',
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
        className="h-10 flex-row items-center self-start rounded-full border border-line px-4"
      >
        <View className="flex-row items-center gap-1.5">
          <Users size={ICON.xs} color={C.brand} />
          <Text className="text-footnote text-ink">{to?.name ?? '공유 대상을 선택해주세요'} ⌄</Text>
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
  );
}

export function SharedScreen() {
  const {
    to = '화학 스터디룸',
    n = '1',
    tab = '필기',
    name = '이차방정식_필기.pdf',
  } = useLocalSearchParams<{ to?: string; n?: string; tab?: string; name?: string }>();
  return (
    <Screen
      footer={
        <>
          <Pressable onPress={() => toast('공유 내역: 오늘 3건')} className="mb-2">
            <Text className="text-center text-caption text-sub underline">공유 내역 보기</Text>
          </Pressable>
          <Btn onPress={() => router.back()}>확인</Btn>
        </>
      }
    >
      <Success
        title="공유가 완료됐어요!"
        body={`${to}에 ${tab} ${n}개를 공유했어요`}
        card={
          <Card className="flex-row items-center gap-3 p-3">
            <View className="h-10 w-10 items-center justify-center rounded-lg bg-mint">
              <FileText size={ICON.sm} color={C.sub} />
            </View>
            <View>
              <Text className="text-subhead font-semibold text-ink">{name}</Text>
              <View className="flex-row items-center gap-1.5">
                <Users size={ICON.xs} color={C.sub} />
                <Text className="text-caption2 text-sub">{to}으로 전송됨</Text>
              </View>
            </View>
          </Card>
        }
      />
    </Screen>
  );
}
