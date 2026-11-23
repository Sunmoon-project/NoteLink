import { useRef, useState } from 'react';
import { ActivityIndicator, Linking, View } from 'react-native';
import { Pressable } from '@/components/press';
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
  Link2,
  List,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Share2,
  Sparkles,
  Trash2,
  Users,
} from 'lucide-react-native';
import type { Material } from '@notelink/shared';
import { api, ApiError } from '@/lib/api';
import { env } from '@/lib/env';
import { toast } from '@/stores/toast';
import { AiPending } from '@/components/AiPending';
import {
  afterSheetClosed,
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
import { PageImages, usePageTurn } from './page-images';
import { TutorBuddy, canAsk, useTuckOnScroll } from '@/features/tutor/buddy';
import { seoul } from '@/lib/dates';
import { QuizFromNote } from './quiz-from-note';
import { useResummarize } from './resummarize';
import { aiStateOf } from '@/lib/ai';
import { FriendShareFooter, ImportButton, useFriendShare } from './friend-share';

// p.67~73 필기 · 녹음 · 문서 상세 / 편집 / 다운로드 / 공유 / 삭제

function useMaterial() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useQuery({
    queryKey: ['material', id],
    queryFn: () => api.content.material(id),
    // 서버가 정리 중이면(다시 요약 포함) 끝날 때까지 다시 읽어 결과 · 실패를 바로 보인다
    refetchInterval: (q) => (aiStateOf(q.state.data?.processing) === 'working' ? 3000 : false),
  });
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

/**
 * 정리 결과가 빈 자료의 안내. 전에는 처리 상태를 보지 않고 늘 「AI 서버를 기다리고 있어요」라 실패한 자료도
 * 기다리는 것처럼 보였다(develop 점검 #3). 실패면 다시 요약(폴더 목록과 같은 경로), 처리 중이면 진행 표시,
 * 기기 저장 모드일 때만 서버 대기 안내
 */
function SummaryStatus({
  m,
  what,
  failed,
  retry,
  working,
  empty,
  hint,
}: {
  m: Material;
  what: string;
  failed: string;
  retry: string;
  working: string;
  empty: string;
  hint?: string;
}) {
  const resummarize = useResummarize();
  // 남의 노트는 다시 정리할 수 없다(주인 작업이라 404)
  const { readOnly } = useFriendShare();
  const state = aiStateOf(m.processing);
  if (state === 'waiting') return <AiPending what={what} hint={hint} />;
  const [title, sub] =
    state === 'failed'
      ? [
          failed,
          hint ?? (m.processing.jobId && !readOnly ? '다시 눌러 정리해 볼 수 있어요.' : undefined),
        ]
      : state === 'working'
        ? [working, '끝나면 여기에 바로 보여요.']
        : [empty, hint];
  return (
    <View className="flex-row items-center gap-3 rounded-2xl bg-mint p-4">
      {state === 'working' ? (
        <ActivityIndicator size="small" color={C.brand} />
      ) : (
        <Sparkles size={ICON.md} color={state === 'failed' ? C.danger : C.brand} />
      )}
      <View className="flex-1">
        <Text className="text-subhead font-semibold text-ink">{title}</Text>
        {!!sub && <Text className="mt-0.5 text-footnote text-sub">{sub}</Text>}
      </View>
      {state === 'failed' && !!m.processing.jobId && !readOnly && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={retry}
          hitSlop={8}
          disabled={resummarize.isPending}
          onPress={() => resummarize.mutate(m)}
          className="flex-row items-center gap-1 rounded-full bg-white px-3 py-1.5"
        >
          {resummarize.isPending ? (
            <ActivityIndicator size="small" color={C.brand} />
          ) : (
            <RotateCcw size={ICON.xs} color={C.brand} />
          )}
          <Text className="text-caption font-semibold text-brand">{retry}</Text>
        </Pressable>
      )}
    </View>
  );
}

/** 원본이 PDF인지: 쪽 주소의 경로가 .pdf로 끝나는지(?쿼리 · #조각은 빼고, 대소문자 구분 없이) */
export function isPdfOriginal(pages: Material['pages']): boolean {
  return !!pages?.some((p) => /\.pdf$/i.test(p.imageUrl.split(/[?#]/)[0] ?? ''));
}

/** 자료가 든 폴더의 과목 이름 */
function useSubject(folderId?: string) {
  const folders = useQuery({ queryKey: ['folders'], queryFn: api.content.folders });
  return folders.data?.find((f) => f._id === folderId)?.subjectName;
}

/** 정리본을 마크다운으로: 제목 · 핵심 요약 · 정리된 내용 · 키워드 (서버에는 정리본 파일이 없어 앱이 만든다) */
export function summaryMarkdown(m: Pick<Material, 'title' | 'summary' | 'keywords'>): string {
  const out = [`# ${m.title}`];
  if (m.summary?.points.length)
    out.push('## 핵심 요약', m.summary.points.map((p) => `- ${p}`).join('\n'));
  for (const s of m.summary?.sections ?? []) out.push(`## ${s.heading}`, s.body);
  if (m.keywords.length) out.push('## 키워드', m.keywords.join(' · '));
  return out.join('\n\n') + '\n';
}

/** 원본 파일을 시스템 미리보기 · 공유 시트로 연다 (파일 앱에 저장 · 다른 앱으로 열기) */
async function openOriginal(id: string) {
  const { url } = await api.content.downloadUrl(id);
  if (url.startsWith('file://') && (await Sharing.isAvailableAsync()))
    return Sharing.shareAsync(url);
  if (!/^https?:\/\//i.test(url)) throw new Error('원본 주소가 없어요');
  await Linking.openURL(url);
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
  const pageTurn = usePageTurn();
  const { tab: t } = useLocalSearchParams<{ tab?: '정리된 노트' | '원본 이미지' }>();
  const { id, m, isError, refetch } = useMaterial();
  const [tab, setTab] = useState<'정리된 노트' | '원본 이미지'>(t ?? '정리된 노트');
  const [opt, setOpt] = useState(false);
  const subject = useSubject(m?.folderId);
  const buddy = useTuckOnScroll();
  const shared = useFriendShare();
  if (isError) return <MaterialError retry={refetch} />;
  if (!m) return <Loading />;
  return (
    <Canvas>
      <Screen
        onScroll={buddy.onScroll}
        overlay={canAsk(m) && !shared.readOnly && <TutorBuddy id={id} tucked={buddy.tucked} />}
        footer={
          shared.shareId ? (
            <FriendShareFooter shareId={shared.shareId} />
          ) : shared.room ? (
            <ImportButton id={id} kind={m.kind} />
          ) : (
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
          )
        }
      >
        <Header
          title={m.title}
          sub={dateLabel(m, '필기')}
          large={false}
          right={!shared.readOnly && <More onPress={() => setOpt(true)} />}
        />
        {!shared.readOnly && <QuizFromNote material={m} className="mb-3" />}
        <Segment items={['정리된 노트', '원본 이미지'] as const} value={tab} onChange={setTab} />
        <View className="mt-4">
          {tab === '정리된 노트' ? (
            m.summary?.sections.length ? (
              <NoteBody sections={m.summary.sections} diagrams={m.diagrams} />
            ) : (
              <SummaryStatus
                m={m}
                what="필기 정리"
                failed="정리하지 못했어요"
                retry="다시 정리"
                working="필기를 정리하고 있어요"
                empty="정리된 내용이 없어요"
                hint={
                  !shared.readOnly
                    ? "직접 정리하려면 '편집하기'를 눌러 써 보세요."
                    : // 정리가 끝나지 않은 노트는 가져오기도 거절된다(409) — 올린 사람이 다시 정리해야 한다
                      aiStateOf(m.processing) === 'failed'
                      ? '올린 사람이 다시 정리하면 볼 수 있어요.'
                      : '내 폴더로 가져오면 직접 정리할 수 있어요.'
                }
              />
            )
          ) : (
            <View className="gap-3">
              {!!m.pages?.length && <PageImages pages={m.pages} mode={pageTurn} />}
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

export type Format = 'bold' | 'heading' | 'list' | 'link';
type Selection = { start: number; end: number };

/**
 * 툴바 서식을 글에 넣는다. 노트는 글자로만 저장하므로 마크다운 기호를 쓰고 상세 화면(NoteBody)이 그 표시대로 그린다.
 * 굵게 · 링크는 고른 글자를 감싸고(없으면 틀을 넣는다), 제목 · 목록은 커서가 있는 줄 앞에 붙이거나(이미 있으면) 뗀다
 */
export function applyFormat(
  text: string,
  sel: Selection,
  format: Format,
): { text: string; sel: Selection } {
  const start = Math.min(sel.start, sel.end, text.length);
  const end = Math.min(Math.max(sel.start, sel.end), text.length);
  if (format === 'bold' || format === 'link') {
    const picked = text.slice(start, end) || (format === 'bold' ? '굵게' : '링크');
    const wrapped = format === 'bold' ? `**${picked}**` : `[${picked}](https://)`;
    const next = text.slice(0, start) + wrapped + text.slice(end);
    return { text: next, sel: { start: start + wrapped.length, end: start + wrapped.length } };
  }
  const mark = format === 'heading' ? '# ' : '- ';
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const has = text.startsWith(mark, lineStart);
  const next = has
    ? text.slice(0, lineStart) + text.slice(lineStart + mark.length)
    : text.slice(0, lineStart) + mark + text.slice(lineStart);
  const shift = has ? -mark.length : mark.length;
  const at = Math.max(lineStart, end + shift);
  return { text: next, sel: { start: at, end: at } };
}

/**
 * 저장할 섹션. 아무것도 쓰지 않은 섹션은 빼고, 제목 없이 본문만 쓴 섹션은 「내용 N」 제목을 붙인다 —
 * 서버는 제목 1자 이상만 받아(UpdateMaterialDto) 제목을 비운 채 저장하면 400으로 거절해 고친 글이 저장되지 않았다.
 * 「내용 N」은 서버가 자동 요약에서 제목 없는 조각에 붙이는 이름과 같다(material-sync)
 */
export function summaryForSave(sections: { heading: string; body: string }[]) {
  const kept = sections.filter((s) => s.heading.trim() || s.body.trim());
  // 사용자가 직접 「내용 2」라고 쓴 제목과 겹치지 않게 다음 번호로 넘긴다(서버 uniqueHeading과 같은 뜻)
  const used = new Set(kept.map((s) => s.heading.trim()).filter(Boolean));
  return kept.map((s, i) => {
    if (s.heading.trim()) return s;
    let n = i + 1;
    while (used.has(`내용 ${n}`)) n++;
    used.add(`내용 ${n}`);
    return { ...s, heading: `내용 ${n}` };
  });
}

const TOOLS = [
  [Bold, '굵게', 'bold'],
  [Heading1, '제목', 'heading'],
  [List, '목록', 'list'],
  [Link2, '링크', 'link'],
] as const;

const Toolbar = ({ onFormat }: { onFormat: (f: Format) => void }) => (
  <View className="flex-row items-center justify-center gap-2 rounded-xl bg-white py-1.5">
    {TOOLS.map(([I, label, f]) => (
      <Pressable
        key={f}
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={() => onFormat(f)}
        className="h-11 w-14 items-center justify-center rounded-lg active:bg-fill"
      >
        <I size={ICON.sm} color={C.ink} />
      </Pressable>
    ))}
  </View>
);

export function EditScreen() {
  const { id, m, isError, refetch } = useMaterial();
  const qc = useQueryClient();
  const [sections, setSections] = useState<{ heading: string; body: string }[]>([]);
  const [editing, setEditing] = useState(false);
  // 툴바가 바꿀 곳: 마지막으로 누른 본문 칸과 그 안의 커서 · 고른 범위
  const target = useRef<{ index: number; sel: Selection }>({ index: 0, sel: { start: 0, end: 0 } });
  // 자료를 처음 불러왔을 때만 편집할 본문을 채운다 — 재조회가 고치던 글을 덮어쓰지 않게 (렌더 중 상태 조정)
  const [loaded, setLoaded] = useState<string>();
  if (m && m._id !== loaded) {
    setLoaded(m._id);
    setSections((m.summary?.sections ?? []).map((section) => ({ ...section })));
  }
  const format = (f: Format) => {
    const { index } = target.current;
    const section = sections[index];
    if (!section) return toast('서식을 넣을 본문을 먼저 눌러 주세요');
    const next = applyFormat(section.body, target.current.sel, f);
    target.current = { index, sel: next.sel };
    setSections((all) => all.map((s, i) => (i === index ? { ...s, body: next.text } : s)));
  };
  const save = useMutation({
    mutationFn: () => {
      if (!m || loaded !== id) throw new Error('자료를 먼저 불러와 주세요');
      return api.content.updateSummary(id, summaryForSave(sections));
    },
    onError: (e) =>
      toast(e instanceof ApiError ? e.message : '노트를 저장하지 못했어요. 다시 시도해주세요'),
    onSuccess: (saved) => {
      // 상세 화면이 저장한 글을 바로 보이게 응답으로 캐시를 바꾸고 다시 읽는다
      if (saved) qc.setQueryData(['material', id], saved);
      void qc.invalidateQueries({ queryKey: ['material', id] });
      router.back();
      toast('노트를 저장했어요');
    },
  });
  if (isError) return <MaterialError retry={refetch} />;
  return (
    <Canvas>
      <Screen
        // 키보드가 올라와도 툴바 · 취소 · 저장은 키보드 바로 위에 남는다(Screen이 키보드만큼 줄인다)
        footer={
          <>
            <Toolbar onFormat={format} />
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
        }
      >
        <Header title="노트 편집" large={false} />
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
                className="text-subhead font-bold text-ink"
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
                onSelectionChange={(e) => {
                  target.current = { index, sel: e.nativeEvent.selection };
                }}
                onFocus={() => {
                  setEditing(true);
                  if (target.current.index !== index) {
                    const end = section.body.length;
                    target.current = { index, sel: { start: end, end } };
                  }
                }}
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
      </Screen>
    </Canvas>
  );
}

export function RecDetailScreen() {
  const { view, bookmarks } = useLocalSearchParams<{ view?: 'text'; bookmarks?: string }>();
  const { id, m, isError, refetch } = useMaterial();
  const [opt, setOpt] = useState(false);
  const subject = useSubject(m?.folderId);
  const shared = useFriendShare();
  if (isError) return <MaterialError retry={refetch} />;
  if (!m) return <Loading />;
  return (
    <Canvas>
      {/* 떠 있는 아바타 선생님은 두지 않는다: 플레이어 자막 옆 3D 아바타가 녹음에 맞춰 말한다(GL 화면 하나) */}
      <Screen
        footer={
          shared.shareId ? (
            <FriendShareFooter shareId={shared.shareId} />
          ) : shared.room ? (
            <ImportButton id={id} kind={m.kind} />
          ) : undefined
        }
      >
        <Header
          title={view === 'text' ? '원문 텍스트 보기' : m.title}
          sub={dateLabel(m, '녹음')}
          large={false}
          right={!shared.readOnly && <More onPress={() => setOpt(true)} />}
        />
        {!shared.readOnly && <QuizFromNote material={m} className="mb-3" />}
        <View className="mb-3 flex-row items-center gap-2">
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
          readOnly={shared.readOnly}
        />
      </Screen>
      <FileOptions m={m} open={opt} onClose={() => setOpt(false)} />
    </Canvas>
  );
}

export function DocDetailScreen() {
  const pageTurn = usePageTurn();
  const { tab: t } = useLocalSearchParams<{ tab?: '요약' | '원본 문서' }>();
  const { id, m, isError, refetch } = useMaterial();
  const [tab, setTab] = useState<'요약' | '원본 문서'>(t ?? '요약');
  const [opt, setOpt] = useState(false);
  const subject = useSubject(m?.folderId);
  const buddy = useTuckOnScroll();
  const shared = useFriendShare();
  const [pick, setPick] = useState(false);
  const download = useMutation({
    mutationFn: async (what: 'summary' | 'original') => {
      // 고르기 시트(Modal)가 닫히는 중에 공유 시트를 띄우면 Modal과 함께 사라져 shareAsync가 끝나지 않았다
      // (스피너가 계속 돌고 완료 화면이 안 뜸, iOS QA TC-NOTE-021) → 다 닫힌 뒤에 띄운다
      await afterSheetClosed();
      if (what === 'summary') {
        // 파일 이름에 쓸 수 없는 글자는 뺀다
        const fileName = `${m!.title.replace(/[\\/:*?"<>|]/g, ' ').trim() || '정리본'}.md`;
        const dir = new Directory(Paths.document, 'downloads');
        if (!dir.exists) dir.create();
        const out = new File(dir, fileName);
        if (out.exists) out.delete();
        out.create();
        out.write(summaryMarkdown(m!));
        if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(out.uri);
        return fileName;
      }
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
    // 정리본은 기기에서 파일을 만드는 일이라 연결 문제가 아니다
    onError: (_e, what) =>
      toast(
        what === 'summary'
          ? '정리본을 저장하지 못했어요. 기기 저장 공간을 확인해 주세요'
          : '다운로드하지 못했어요. 연결을 확인해 주세요',
      ),
  });
  if (isError) return <MaterialError retry={refetch} />;
  if (!m) return <Loading />;
  return (
    <Canvas>
      <Screen
        onScroll={buddy.onScroll}
        overlay={canAsk(m) && !shared.readOnly && <TutorBuddy id={id} tucked={buddy.tucked} />}
        footer={
          shared.shareId ? (
            <FriendShareFooter shareId={shared.shareId} />
          ) : shared.room ? (
            <ImportButton id={id} kind={m.kind} />
          ) : (
            <Two>
              <Btn
                kind="outline"
                onPress={() => router.push({ pathname: '/note-share', params: { id } })}
              >
                공유하기
              </Btn>
              <Btn loading={download.isPending} onPress={() => setPick(true)}>
                다운로드
              </Btn>
            </Two>
          )
        }
      >
        <Header
          title={m.title}
          sub={`${dateLabel(m, '문서')}${m.pages?.length ? ` · ${m.pages.length}페이지` : ''}`}
          large={false}
          right={!shared.readOnly && <More onPress={() => setOpt(true)} />}
        />
        {!shared.readOnly && <QuizFromNote material={m} className="mb-3" />}
        <Segment items={['요약', '원본 문서'] as const} value={tab} onChange={setTab} />
        {tab === '요약' ? (
          <View className="mt-4">
            {m.summary?.points.length ? (
              <DocSummary points={m.summary.points} keywords={m.keywords} />
            ) : (
              <SummaryStatus
                m={m}
                what="문서 요약"
                failed="요약하지 못했어요"
                retry="다시 요약"
                working="문서 요약을 만들고 있어요"
                empty="요약할 내용을 찾지 못했어요"
              />
            )}
            {/* 편집하기로 고친 글(섹션)도 보인다 — 전에는 핵심 요약만 보여 문서를 고쳐도 바뀐 게 없어 보였다 */}
            {!!m.summary?.sections.length && (
              <>
                <Label>정리된 내용</Label>
                <NoteBody sections={m.summary.sections} diagrams={m.diagrams} />
              </>
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
            {isPdfOriginal(m.pages) ? (
              <Text className="text-caption text-sub">PDF는 원본 파일 열기로 볼 수 있어요</Text>
            ) : (
              !!m.pages?.length && <PageImages pages={m.pages} mode={pageTurn} />
            )}
            <OriginalFile m={m} />
          </View>
        )}
      </Screen>
      <FileOptions m={m} open={opt} onClose={() => setOpt(false)} />
      {/* 다운로드는 원본만 받았다(실기기 피드백 2026-11-20). 정리본 · 원본 중 고른다 */}
      <Sheet open={pick} onClose={() => setPick(false)} title="무엇을 받을까요?">
        <Group>
          {/* 정리가 아직 없으면 원본만 */}
          {(m.summary?.points.length || m.summary?.sections.length
            ? (['summary', 'original'] as const)
            : (['original'] as const)
          ).map((what) => (
            <Row
              key={what}
              chevron
              onPress={() => {
                setPick(false);
                download.mutate(what);
              }}
            >
              {what === 'summary' ? '정리본 (.md)' : '원본 파일'}
            </Row>
          ))}
        </Group>
      </Sheet>
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

/** 한 번에 보낼 수 있는 친구 수(서버 SHARE_MAX_FRIENDS · 시간표 공유와 같다) */
const SHARE_MAX_FRIENDS = 50;

export function ShareScreen() {
  const { id, folderId } = useLocalSearchParams<{ id?: string; folderId?: string }>();
  const qc = useQueryClient();
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
  const targets = (rooms.data ?? []).map((r) => ({
    type: 'room' as const,
    id: r._id,
    name: r.title,
  }));
  const [to, setTo] = useState<{ type: 'room'; id: string; name: string } | null>(null);
  // 친구는 여러 명 고른다(#554). 스터디룸을 고르면 비우고, 친구를 고르면 스터디룸을 비운다(한 번에 한 쪽)
  const [pals, setPals] = useState<string[]>([]);
  const [pick, setPick] = useState(false);
  const friendList = env.localData ? [] : (friends.data ?? []);
  const chosen = friendList.filter((f) => pals.includes(f.userId));
  const roomOk = !!to && targets.some((t) => t.id === to.id);
  const togglePal = (userId: string) => {
    setTo(null);
    setPals((p) => {
      if (p.includes(userId)) return p.filter((x) => x !== userId);
      if (p.length >= SHARE_MAX_FRIENDS) {
        toast(`친구는 한 번에 ${SHARE_MAX_FRIENDS}명까지 보낼 수 있어요`);
        return p;
      }
      return [...p, userId];
    });
  };
  const list = (mats.data ?? []).filter((m) => m.kind === TABS[tab]);
  const selected = list.filter((m) => sel.includes(m._id));
  const selectedIds = selected.map((m) => m._id);
  const ready = !!selectedIds.length && (roomOk || chosen.length > 0);
  const share = useMutation({
    mutationFn: () => {
      if (!ready) throw new Error('공유 대상을 선택해주세요');
      return api.content.share({
        materialIds: selectedIds,
        target: roomOk
          ? { type: 'room', id: to!.id }
          : { type: 'friend', ids: chosen.map((f) => f.userId) },
      });
    },
    // 서버가 이유를 들어 거절(4xx)했으면 그 문구, 아니면 연결 문제로 안내한다
    onError: (e) =>
      toast(
        e instanceof ApiError && e.status >= 400 && e.status < 500 && e.message
          ? e.message
          : '공유하지 못했어요. 연결을 확인하고 다시 시도해 주세요',
      ),
    onSuccess: () => {
      // 방의 「공유 자료」가 옛 목록을 들고 있지 않게
      if (roomOk) void qc.invalidateQueries({ queryKey: ['room-shared', to!.id] });
      router.replace({
        pathname: '/note-shared',
        params: {
          ...(roomOk
            ? { to: to!.name }
            : { to: chosen[0]!.nickname, kind: 'friend', more: String(chosen.length - 1) }),
          n: String(selectedIds.length),
          tab,
          name: selected[0]?.title,
        },
      });
    },
  });
  const label = to
    ? to.name
    : chosen.length
      ? chosen.length > 1
        ? `${chosen[0]!.nickname}님 외 ${chosen.length - 1}명`
        : `${chosen[0]!.nickname}님`
      : '공유 대상을 선택해주세요';
  return (
    <Canvas>
      <Screen
        footer={
          <Btn disabled={!ready} loading={share.isPending} onPress={() => share.mutate()}>
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
          // 보내는 동안 대상을 바꾸면 완료 화면 문구가 실제로 보낸 대상과 달라진다
          disabled={share.isPending}
          onPress={() => setPick(true)}
          className="h-10 flex-row items-center self-start rounded-full bg-white px-4"
        >
          <View className="flex-row items-center gap-1.5">
            <Users size={ICON.xs} color={C.brand} />
            <Text className="text-footnote text-ink">{label} ⌄</Text>
          </View>
        </Pressable>
        <Sheet open={pick} onClose={() => setPick(false)} title="공유 대상">
          <Label>스터디룸</Label>
          {rooms.isError && !rooms.data ? (
            <Text className="px-1 text-footnote text-sub">스터디룸 목록을 불러오지 못했어요</Text>
          ) : rooms.isSuccess && targets.length === 0 ? (
            <Text className="px-1 text-footnote text-sub">참여 중인 스터디룸이 없어요</Text>
          ) : (
            <Group>
              {targets.map((x) => (
                <Row
                  key={x.id}
                  onPress={() => {
                    setTo(x);
                    setPals([]);
                    setPick(false);
                  }}
                  right={to?.id === x.id && <Check size={ICON.sm} color={C.brand} />}
                >
                  {x.name}
                </Row>
              ))}
            </Group>
          )}
          <Label>친구</Label>
          {env.localData ? (
            // 기기 저장 모드에는 친구가 없다. 연결 문제처럼 읽히지 않게 무엇을 하면 되는지만 말한다
            <Text className="px-1 text-footnote text-sub">
              서버에 연결하면 친구에게 보낼 수 있어요
            </Text>
          ) : friends.isError && !friends.data ? (
            <Text className="px-1 text-footnote text-sub">친구 목록을 불러오지 못했어요</Text>
          ) : (
            friends.isSuccess &&
            (friendList.length ? (
              <>
                <Group>
                  {friendList.map((f) => {
                    const on = pals.includes(f.userId);
                    return (
                      <Row
                        key={f.userId}
                        selected={on}
                        onPress={() => togglePal(f.userId)}
                        right={on && <Check size={ICON.sm} color={C.brand} />}
                      >
                        {f.nickname}
                      </Row>
                    );
                  })}
                </Group>
                {chosen.length > 0 && (
                  <Btn className="mt-3" onPress={() => setPick(false)}>
                    {`친구 ${chosen.length}명 고르기`}
                  </Btn>
                )}
              </>
            ) : (
              <Text className="px-1 text-footnote text-sub">아직 친구가 없어요</Text>
            ))
          )}
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
    kind,
    more = '0',
  } = useLocalSearchParams<{
    to?: string;
    n?: string;
    tab?: string;
    name?: string;
    kind?: 'friend';
    more?: string;
  }>();
  // 친구는 「민지님에게」 · 「민지님 외 2명에게」, 스터디룸은 「국어방 스터디룸」처럼 겹치지 않게
  const others = Number(more) || 0;
  const where = !to
    ? undefined
    : kind === 'friend'
      ? `${to}님${others > 0 ? ` 외 ${others}명` : ''}에게`
      : `${to}${/(방|스터디룸)$/.test(to) ? '' : ' 스터디룸'}에`;
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
          body={where ? `${where} ${tab} ${n}개를 공유했어요` : `${tab} ${n}개를 공유했어요`}
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
                    {where ? `${where} 보냈어요` : '보냈어요'}
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
