import { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, View } from 'react-native';
import { Text } from '@/components/text';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, FileText, Image, Pin } from 'lucide-react-native';
import { ERROR_CODES, type AiJob } from '@notelink/shared';
import { api, NetworkError } from '@/lib/api';
import { uploadToBlob } from '@/lib/upload';
import { aiWaiting } from '@/lib/ai';
import { notifyLocal } from '@/lib/push';
import { socket } from '@/lib/socket';
import { useSocket } from '@/hooks';
import { useDraft } from '@/stores/draft';
import { scanTitle } from '@/lib/scan-title';
import { useAuth } from '@/stores/auth';
import { useNet } from '@/stores/net';
import { toast } from '@/stores/toast';
import {
  Alert,
  Btn,
  Canvas,
  Card,
  Chip,
  Empty,
  Header,
  Label,
  Loading,
  Pie,
  Progress,
  Screen,
  Sheet,
  Success,
  Toggle,
  cx,
} from '@/components/ui';
import { C, ICON } from '@/theme';
import { Player } from './player';

// p.66 AI 변환 중 · 정리 완료 / p.98 업로드 · 변환 중 연결 끊김 / p.99 LLM 오류

const TITLE = {
  handwriting: '필기를 학습 자료로 변환하고 있어요',
  recording: '녹음을 학습 자료로 변환하고 있어요',
  document: '문서를 요약하고 있어요',
};
const STEPS = {
  handwriting: ['이미지 업로드', '손글씨 인식', '노트 정리', 'AI 요약 생성'],
  recording: ['녹음 업로드', '음성 인식', '노트 정리', 'AI 요약 · 아바타 생성'],
  document: ['문서 업로드', '문서 읽기', '핵심 요약', '키워드 추출'],
};

const DETAIL = { handwriting: 'hand', recording: 'rec', document: 'doc' } as const;

/** 원본은 저장됐고 AI 정리는 서버를 기다리는 상태 */
function SavedForLater({
  kind,
  materialId,
  folderId,
}: {
  kind: keyof typeof DETAIL;
  materialId: string;
  folderId: string | null | undefined;
}) {
  const qc = useQueryClient();
  // 아래에서 초안을 비우므로 처음 받은 폴더를 붙들어 둔다
  const [folder] = useState(folderId);
  useEffect(() => {
    qc.invalidateQueries({ queryKey: ['folders'] });
    qc.invalidateQueries({ queryKey: ['materials'] });
    // 올린 파일만큼 저장 공간이 늘었다
    qc.invalidateQueries({ queryKey: ['me'] });
    useDraft.getState().reset();
  }, [qc]);
  return (
    <Canvas>
      <Screen
        footer={
          <>
            <Btn
              onPress={() => {
                // 모달을 상세로 바로 바꾸면 노트 탭에 상세 하나만 남아 뒤로 가기가 홈으로 간다.
                // 자료를 넣은 폴더까지 돌아간 뒤 상세를 열어, 뒤로 가면 폴더가 나오게 한다
                router.dismissTo(
                  folder
                    ? { pathname: '/(tabs)/note/folder/[id]', params: { id: folder } }
                    : '/(tabs)/note',
                );
                router.push({
                  pathname: `/(tabs)/note/${DETAIL[kind]}/[id]`,
                  params: { id: materialId },
                });
              }}
            >
              자료 보기
            </Btn>
            <Btn kind="ghost" className="mt-2" onPress={() => router.dismissTo('/(tabs)/note')}>
              노트로 돌아가기
            </Btn>
          </>
        }
      >
        <Success
          title="자료를 저장했어요"
          body={'원본은 이 기기에 저장됐어요.\nAI 정리는 서버가 연결되면 이어서 진행돼요.'}
        />
      </Screen>
    </Canvas>
  );
}

export function ConvertScreen() {
  const draft = useDraft();
  // 저장을 마치면 초안이 비워지므로 자료 종류는 처음 값을 기억한다
  const [kind] = useState(draft.kind);
  const qc = useQueryClient();
  const net = useNet((s) => s.state);
  const [phase, setPhase] = useState<'upload' | 'paused' | 'ai' | 'failed' | 'uncertain'>('upload');
  const [uploadPct, setUploadPct] = useState(0);
  const [job, setJob] = useState<AiJob | null>(null);
  const [materialId, setMaterialId] = useState<string | null>(null);
  const [cancel, setCancel] = useState(false);
  const [notify, setNotify] = useState(true);
  const [attempts, setAttempts] = useState(1);
  const blobs = useRef<string[]>([]);
  const bg = useRef(false); // 소켓 콜백용
  const [inBg, setInBg] = useState(false); // 화면 표시용
  const [uploaded, setUploaded] = useState(0);
  const abort = useRef(new AbortController());
  const running = useRef(false);
  const handled = useRef(false);
  const canceled = useRef(false);
  const checkingRegistration = useRef(false);
  const [checking, setChecking] = useState(false);

  const requireFolder = () => {
    if (!draft.folderId) throw new Error('자료를 넣을 폴더가 없어요');
    return draft.folderId;
  };
  // 처음 상태가 'upload'라 다시 시도할 때만 호출하는 쪽에서 phase를 되돌린다
  const run = async () => {
    if (running.current || canceled.current) return;
    running.current = true;
    setPhase('upload');
    try {
      // 1) 끊긴 지점부터: 이미 올린 파일은 건너뛴다 (원본은 기기에 보관)
      for (let i = blobs.current.length; i < draft.files.length; i++) {
        const file = draft.files[i];
        if (!file) continue;
        const kind =
          draft.kind === 'recording' ? 'audio' : draft.kind === 'document' ? 'document' : 'image';
        const cached = useDraft.getState().uploads.find((upload) => upload.file === file);
        const url =
          cached?.url ??
          (await uploadToBlob(
            kind,
            file,
            (p) => setUploadPct(Math.round(((i + p / 100) / draft.files.length) * 100)),
            abort.current.signal,
          ));
        useDraft.getState().rememberUpload(file, url);
        blobs.current.push(url);
        setUploadPct(Math.round(((i + 1) / draft.files.length) * 100));
        setUploaded(blobs.current.length);
      }
      // 2) 서버에 자료 등록 → ai_jobs 큐에 작업이 들어간다
      const r = await api.content.createMaterial({
        requestId: useDraft.getState().getCreationId(),
        folderId: requireFolder(),
        kind: draft.kind,
        source: draft.source,
        title: draft.title.trim() || defaultTitle(draft.kind, draft.files[0]?.name, draft.source),
        description: draft.description,
        blobUrls: blobs.current,
        avatarItemId: draft.avatar,
      });
      if (canceled.current) {
        await api.ai.cancel(r.job._id);
        return;
      }
      handled.current = false;
      setMaterialId(r.material._id);
      setJob(r.job);
      setPhase('ai');
    } catch (e) {
      if (!canceled.current)
        setPhase(
          e instanceof Error && 'code' in e && e.code === 'MATERIAL_REGISTRATION_UNCERTAIN'
            ? 'uncertain'
            : e instanceof NetworkError
              ? 'paused'
              : 'failed',
        );
    } finally {
      running.current = false;
    }
  };
  useEffect(() => {
    run();
    const sub = AppState.addEventListener('change', (s) => {
      bg.current = s !== 'active';
      setInBg(bg.current);
    });
    const ctrl = abort.current;
    return () => {
      sub.remove();
      ctrl.abort();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 작업이 바뀔 때마다(처음 등록 · 다시 시도로 새 작업) 그 작업의 진행 상황을 구독한다
  useEffect(() => {
    if (job?._id) socket.emit('ai:subscribe', { jobId: job._id });
  }, [job?._id]);

  useSocket(
    'ai:progress',
    (p) => {
      if (p.jobId !== job?._id) return;
      setJob((j) => (j ? { ...j, progress: p.progress, status: p.status, step: p.step } : j));
    },
    [job?._id],
  );
  const finish = (done: AiJob) => {
    if (
      canceled.current ||
      handled.current ||
      !['succeeded', 'failed', 'canceled'].includes(done.status)
    )
      return;
    handled.current = true;
    setJob(done);
    if (done.status === 'succeeded') {
      if (bg.current && notify)
        notifyLocal('변환이 끝났어요', `${draft.title || '학습 자료'} 정리본을 확인해 보세요`);
      qc.invalidateQueries({ queryKey: ['materials'] });
      router.replace({ pathname: '/result/[id]', params: { id: done.targetId } });
    } else setPhase('failed');
  };
  useSocket(
    'ai:done',
    ({ jobId, job: done }) => {
      if (jobId === job?._id) finish(done);
    },
    [job?._id, notify],
  );

  useEffect(() => {
    if (phase !== 'ai' || !job || handled.current) return;
    let disposed = false;
    const poll = async () => {
      if (disposed || handled.current) return;
      try {
        const done = await api.ai.job(job._id);
        if (disposed || handled.current) return;
        setAttempts(done.attempts);
        finish(done);
      } catch {
        if (!disposed) toast('작업 상태를 확인하지 못했어요. 다시 연결하면 확인해요');
      }
    };
    const id = setInterval(poll, 1500);
    return () => {
      disposed = true;
      clearInterval(id);
    };
  }, [phase, job?._id]); // eslint-disable-line react-hooks/exhaustive-deps

  const retry = useMutation({
    mutationFn: () => api.ai.retry(job!._id),
    onSuccess: (j) => {
      handled.current = false;
      setJob(j);
      setPhase('ai');
      setAttempts(1);
    },
  });
  const doCancel = async () => {
    canceled.current = true;
    abort.current.abort();
    if (job) await api.ai.cancel(job._id).catch(() => {});
    router.back();
  };

  const confirmRegistration = async () => {
    if (checkingRegistration.current) return;
    checkingRegistration.current = true;
    setChecking(true);
    const owner = useAuth.getState().userId;
    const active = () =>
      !abort.current.signal.aborted && !canceled.current && useAuth.getState().userId === owner;
    try {
      const folderId = requireFolder();
      // 캐시의 나이나 이전 조회 상태와 무관하게 등록 여부를 서버에서 새로 확인한다.
      await qc.cancelQueries({ queryKey: ['materials', folderId], exact: true });
      if (!active()) return;
      const materials = await api.content.materials(folderId);
      if (!active()) return;
      qc.setQueryData(['materials', folderId], materials);
      void qc.invalidateQueries({ queryKey: ['folders'] });
      router.dismissTo({ pathname: '/(tabs)/note/folder/[id]', params: { id: folderId } });
      toast('목록에 없으면 저장을 마치지 못한 자료예요. 필요하면 다시 올려주세요');
    } catch {
      if (active()) toast('등록 여부를 확인하지 못했어요. 연결을 확인하고 다시 눌러주세요');
    } finally {
      checkingRegistration.current = false;
      if (!abort.current.signal.aborted) setChecking(false);
    }
  };
  const credit = job?.error === ERROR_CODES.AI_CREDIT_EXHAUSTED;
  const pct =
    phase === 'upload'
      ? Math.round(uploadPct * 0.25)
      : phase === 'paused'
        ? 0
        : (job?.progress ?? 0);
  const step = phase === 'upload' ? 0 : pct < 50 ? 1 : pct < 85 ? 2 : 3;
  const steps = STEPS[draft.kind];
  // AI 서버가 없으면(기기 저장 모드) 원본만 저장하고 정리는 서버 연결 후에 한다 (FR-65-05)
  if (phase === 'ai' && aiWaiting(job) && materialId)
    return <SavedForLater kind={kind} materialId={materialId} folderId={draft.folderId} />;
  return (
    <Canvas>
      <Screen>
        {phase === 'ai' && net !== 'ok' && (
          <View className="mt-3 rounded-xl border border-brand/30 bg-mint px-4 py-2.5">
            <Text className="text-footnote font-semibold text-brand">
              ● 앱을 닫아도 서버에서 계속 변환돼요
            </Text>
          </View>
        )}
        {phase === 'ai' && attempts > 1 && (
          <View className="mt-3 rounded-xl bg-sun/20 px-4 py-2.5">
            <Text className="text-footnote font-semibold text-ink">AI 응답이 늦어지고 있어요</Text>
            <Text className="text-caption text-sub">
              자동으로 다시 시도하는 중이에요 · 자동 재시도 {attempts} / 3
            </Text>
          </View>
        )}
        <View className="items-end pt-3">
          <Pressable
            onPress={() => setCancel(true)}
            className="rounded-full border border-danger/30 px-3 py-1"
          >
            <Text className="text-footnote text-danger">취소</Text>
          </Pressable>
        </View>
        <View className="mt-10 items-center">
          <View className="h-36 w-36 items-center justify-center rounded-full border-4 border-mint">
            <Pie value={pct} size={112} />
          </View>
          <Text className="mt-2 text-title2 font-bold text-brand">{pct}%</Text>
          <Text className="mt-3 text-body font-bold text-ink">{TITLE[draft.kind]}</Text>
          <Text className="text-footnote text-sub">
            {phase === 'upload'
              ? `원본을 올리는 중이에요 · ${uploadPct}%`
              : '잠시만 기다려주세요...'}
          </Text>
        </View>
        <View className="mt-8 gap-2 px-4">
          {steps.map((s, i) => (
            <Text
              key={s}
              className={cx(
                'text-subhead',
                i < step ? 'text-brand' : i === step ? 'font-bold text-ink' : 'text-sub',
              )}
            >
              {i < step ? `${s} 완료` : i === step ? `${s} 중...` : s}
            </Text>
          ))}
        </View>
        {phase === 'ai' && (net !== 'ok' || inBg) && (
          <Card tone="white" className="mt-8 flex-row items-center px-4 py-3">
            <Text className="flex-1 text-footnote font-semibold text-ink">
              변환이 끝나면 알림으로{'\n'}알려드려요
            </Text>
            <Toggle label="완료 알림" on={notify} onChange={setNotify} />
          </Card>
        )}
        {attempts > 1 && (
          <Text className="mt-6 text-center text-caption2 text-sub">
            응답이 이상하면 1회 다시 요청한 뒤 안내해요
          </Text>
        )}
      </Screen>

      <Alert
        open={phase === 'uncertain'}
        title="등록 결과를 확인할 수 없어요"
        body="같은 자료를 중복 등록하지 않도록 다시 보내지 않았어요. 학습자료 목록에서 등록 여부를 확인해 주세요."
        primary={checking ? '목록 확인 중…' : '학습자료에서 확인'}
        onPrimary={() => {
          void confirmRegistration();
        }}
      />
      <Sheet open={phase === 'paused'} onClose={() => router.back()}>
        <View className="rounded-xl bg-white p-4">
          <View className="flex-row justify-between">
            <Text className="text-callout font-bold text-ink">업로드가 잠시 멈췄어요</Text>
            <Text className="text-caption text-sub">
              {uploaded + 1}/{draft.files.length}
            </Text>
          </View>
          <Text className="text-caption text-sub">{draft.files[uploaded]?.name}</Text>
          <Progress value={uploadPct} className="mt-3" />
          <Text className="mt-2 text-caption text-sub">
            {uploadPct}% 올렸어요 · 연결되면 끊긴 지점부터 이어서 올려요
          </Text>
        </View>
        <View className="mt-2 rounded-xl bg-mint px-3 py-2.5">
          <View className="flex-row items-center gap-1.5">
            <Check size={ICON.xs} color={C.brand} />
            <Text className="text-footnote text-brand">원본은 기기에 보관 중이에요</Text>
          </View>
        </View>
        <Btn className="mt-3" onPress={run}>
          지금 다시 시도
        </Btn>
      </Sheet>
      <Alert
        open={phase === 'failed' && !credit}
        title="정리에 실패했어요"
        body={`원본은 그대로 있어요.\n다시 시도하거나 원본만 저장할 수 있어요.`}
        secondary="원본만 저장"
        onSecondary={async () => {
          if (!materialId) {
            toast('자료가 아직 저장되지 않았어요. 다시 시도해주세요');
            return;
          }
          try {
            await api.content.saveMaterial(materialId);
          } catch {
            toast('원본을 저장하지 못했어요. 다시 시도해주세요');
            return;
          }
          qc.invalidateQueries({ queryKey: ['materials'] });
          router.back();
          toast('원본만 저장했어요');
        }}
        primary="다시 시도"
        onPrimary={() => {
          if (job) return retry.mutate();
          setPhase('upload');
          run();
        }}
      />
      <Alert
        open={phase === 'failed' && credit}
        tone="sun"
        title={'이번 달 AI 크레딧을\n모두 사용했어요'}
        body="완료한 부분은 저장했어요. 갱신 후 이어서 만들 수 있어요."
        secondary="나중에"
        onSecondary={() => router.back()}
        primary="요금제 보기"
        onPrimary={() => router.replace('/(tabs)/profile/plan')}
      />
      <Alert
        open={cancel}
        tone="sun"
        title="변환을 취소할까요?"
        body="올린 원본은 기기에 남아 있어요."
        secondary="계속 변환"
        onSecondary={() => setCancel(false)}
        primary="취소하기"
        onPrimary={doCancel}
      />
    </Canvas>
  );
}

const defaultTitle = (kind: keyof typeof TITLE, name?: string, source?: string) =>
  // 스캔 · 촬영은 파일 이름이 기계식(scan_1794….jpg)이라 제목으로 쓰지 않는다
  (source === 'scan' ? scanTitle() : name?.trim()) ||
  (kind === 'recording' ? '강의 녹음' : kind === 'handwriting' ? '필기 자료' : '학습 자료');

/* ── 정리 완료 (p.66 #21~23) ─────────────────────── */

export function ResultScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const qc = useQueryClient();
  const m = useQuery({ queryKey: ['material', id], queryFn: () => api.content.material(id) });
  const save = useMutation({
    mutationFn: () => api.content.saveMaterial(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['materials'] });
      qc.invalidateQueries({ queryKey: ['folders'] });
      qc.invalidateQueries({ queryKey: ['me'] });
      useDraft.getState().reset();
      router.dismissTo({ pathname: '/(tabs)/note/folder/[id]', params: { id: m.data!.folderId } });
      toast('학습자료에 저장했어요');
    },
  });
  if (m.isError && !m.data)
    return (
      <Canvas>
        <Screen>
          <Header title="변환 결과" large={false} />
          <Empty
            icon={<FileText size={ICON.lg} color={C.brand} />}
            title="변환 결과를 불러오지 못했어요"
            body="연결을 확인하고 다시 시도해 주세요. 원본은 그대로 있어요."
          >
            <Btn small loading={m.isFetching} onPress={() => void m.refetch()}>
              다시 시도
            </Btn>
          </Empty>
        </Screen>
      </Canvas>
    );
  if (!m.data) return <Loading />;
  const mat = m.data;
  return (
    <Canvas>
      <Screen
        footer={
          <Btn loading={save.isPending} onPress={() => save.mutate()}>
            학습자료에 저장
          </Btn>
        }
      >
        {mat.kind === 'handwriting' && (
          <>
            <Header title="노트 정리 완료" large={false} />
            <View className="mb-3 flex-row items-center gap-2">
              <Text className="text-title3 font-bold text-ink">{mat.title}</Text>
            </View>
            <NoteBody sections={mat.summary?.sections ?? []} />
            <Card
              tone="white"
              onPress={() =>
                router.push({
                  pathname: '/result/hand/[id]',
                  params: { id, tab: '원본 이미지' },
                })
              }
              className="mt-3 flex-row items-center px-4 py-3"
            >
              <View className="flex-1 flex-row items-center gap-1.5">
                <Image size={ICON.xs} color={C.brand} />
                <Text className="text-footnote text-ink">원본 필기 보기</Text>
              </View>
              <ChevronRight size={ICON.sm} color={C.sub} />
            </Card>
          </>
        )}
        {mat.kind === 'recording' && (
          <>
            <Header title="녹음 요약 정리" />
            <View className="-mt-2 mb-3 flex-row items-center gap-2">
              <Text className="text-footnote font-semibold text-sub">{mat.title}</Text>
            </View>
            <Player materialId={id} />
          </>
        )}
        {mat.kind === 'document' && (
          <>
            <Header title="문서 요약 완료" />
            <DocSummary
              points={mat.summary?.points ?? []}
              keywords={mat.keywords}
              file={{
                name: mat.title,
                meta: mat.pages?.length ? `${mat.pages.length}페이지` : '원본 문서',
              }}
              onOriginal={() =>
                router.push({ pathname: '/result/doc/[id]', params: { id, tab: '원본 문서' } })
              }
            />
          </>
        )}
      </Screen>
    </Canvas>
  );
}

export const NoteBody = ({ sections }: { sections: { heading: string; body: string }[] }) => (
  <Card className="gap-5 p-5">
    {sections.map((s) => (
      <View key={s.heading}>
        <Text className="text-subhead font-bold text-ink">{s.heading}</Text>
        <Text className="mt-0.5 text-caption text-ink/70">{s.body}</Text>
      </View>
    ))}
  </Card>
);

export function DocSummary({
  points,
  keywords,
  file,
  onOriginal,
}: {
  points: string[];
  keywords: string[];
  file?: { name: string; meta: string };
  onOriginal?: () => void;
}) {
  return (
    <>
      {file && (
        <Card className="flex-row items-center gap-3 p-4">
          <View className="h-11 w-11 items-center justify-center rounded-lg bg-mint">
            <FileText size={ICON.md} color={C.sub} />
          </View>
          <View className="flex-1">
            <Text className="text-callout font-bold text-ink">{file.name}</Text>
            <Text className="text-caption text-sub">{file.meta}</Text>
          </View>
        </Card>
      )}
      <View className="flex-row items-center gap-1.5 mt-5 mb-2">
        <Pin size={ICON.sm} color={C.sub} />
        <Text className="text-subhead font-bold text-ink">핵심 요약</Text>
      </View>
      <Card className="gap-3 p-5">
        {points.map((p) => (
          <View key={p} className="flex-row gap-2">
            <Text className="text-brand">•</Text>
            <Text className="flex-1 text-footnote text-ink">{p}</Text>
          </View>
        ))}
      </Card>
      <Label>키워드</Label>
      <View className="flex-row flex-wrap gap-2">
        {keywords.map((k) => (
          <Chip key={k} small>
            {k}
          </Chip>
        ))}
      </View>
      {onOriginal && (
        <Card tone="white" onPress={onOriginal} className="mt-4 flex-row items-center px-4 py-3">
          <View className="flex-1 flex-row items-center gap-1.5">
            <FileText size={ICON.sm} color={C.sub} />
            <Text className="text-subhead text-ink">원본 문서 보기</Text>
          </View>
          <ChevronRight size={ICON.sm} color={C.sub} />
        </Card>
      )}
    </>
  );
}
