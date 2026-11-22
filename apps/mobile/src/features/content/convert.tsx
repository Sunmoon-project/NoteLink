import { Fragment, useEffect, useRef, useState } from 'react';
import { AppState, Linking, View } from 'react-native';
import { Pressable } from '@/components/press';
import { Text } from '@/components/text';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, FileText, Pin } from 'lucide-react-native';
import {
  ERROR_CODES,
  MATERIAL_MAX_FILES,
  type AiJob,
  type Diagram,
  type NoteDiagram,
} from '@notelink/shared';
import { api, ApiError, NetworkError } from '@/lib/api';
import { uploadToBlob, UploadError } from '@/lib/upload';
import { aiWaiting, stageOf } from '@/lib/ai';
import { notifyLocal, pushRegistered } from '@/lib/push';
import { useBgJobs } from '@/stores/bg-jobs';
import { useAiJobSubscription, useSocket } from '@/hooks';
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
import { AiPending } from '@/components/AiPending';
import { Player } from './player';
import { RecordingDiagram } from './recording-diagram';
import { useSmoothProgress } from '@/hooks/smooth-progress';

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

/** 서버에 등록하기 전에 취소하면 고른 원본을 다시 보여 주는 화면으로 돌아간다 */
/** 등록 중 취소로 늦게 받은 작업을 멈출 때 다시 시도할 간격(화면은 이미 떠났으므로 알아서 다시 보낸다) */
export const LATE_CANCEL_RETRY_MS = [500, 1500];
/**
 * 화면을 떠난 뒤 늦게 받은 작업을 멈춘다. 실패하면 몇 번 더 보내고, 끝내 못 멈추면 알린다
 * (작업은 계속돌아 정리본이 생길 수 있으니 폴더에서 지우면 된다)
 */
async function cancelLateJob(jobId: string) {
  for (let i = 0; ; i++) {
    try {
      await api.ai.cancel(jobId);
      return;
    } catch {
      const wait = LATE_CANCEL_RETRY_MS[i];
      if (wait === undefined) {
        toast('변환 취소를 마치지 못했어요. 정리본이 생기면 폴더에서 지워 주세요');
        return;
      }
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/** 등록 결과를 알 수 없는 실패(서버에 저장됐을 수 있음): 응답 유실 · 연결 끊김 */
const isUncertain = (e: unknown) =>
  e instanceof NetworkError ||
  (e instanceof Error && 'code' in e && e.code === 'MATERIAL_REGISTRATION_UNCERTAIN');

/**
 * 등록 중에 취소했는데 응답이 유실됐을 때. 같은 요청 번호 · 본문으로 다시 보내면 서버가 저장한 결과를 돌려주고
 * (저장하지 않았다면 이때 저장된다 — 원본은 폴더에 남는다), 그 작업을 멈춘다. 끝내 되찾지 못하면 알린다
 */
async function cancelLostRegistration(request: Parameters<typeof api.content.createMaterial>[0]) {
  for (let i = 0; ; i++) {
    try {
      const r = await api.content.createMaterial(request);
      await cancelLateJob(r.job._id);
      return;
    } catch (e) {
      // 처음 등록은 저장됐을 수 있다. 되찾기가 거절(로그인 만료 · 권한 등)되거나 끝내 안 되면 작업이 남아 있을 수
      // 있으니 알린다 — 되찾기 실패만으로 작업이 없다고 보지 않는다(Codex #490 6차 리뷰)
      const wait = isUncertain(e) ? LATE_CANCEL_RETRY_MS[i] : undefined;
      if (wait === undefined) {
        toast('변환 취소를 마치지 못했어요. 정리본이 생기면 폴더에서 지워 주세요');
        return;
      }
      await new Promise((res) => setTimeout(res, wait));
    }
  }
}

const pickedScreen = (kind: keyof typeof DETAIL, source: string) =>
  kind === 'document'
    ? '/capture/picked-file'
    : kind === 'recording'
      ? '/capture/rec-upload'
      : source === 'scan'
        ? '/capture/scan-check'
        : '/capture/picked';

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
  // 변환 취소 요청을 보내는 중 · 그동안 끝난 작업(취소가 실패하면 이어 처리)
  const cancelling = useRef(false);
  const doneWhileCancelling = useRef<AiJob | null>(null);
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
  // 서버에 자료 등록 요청을 보내 응답을 기다리는 중
  const registering = useRef(false);
  const checkingRegistration = useRef(false);
  const [checking, setChecking] = useState(false);
  // 서버에 등록되기 전(올리기 · 등록 단계)에 실패한 이유와, 그 뒤 다시 시도한 횟수
  const [uploadFail, setUploadFail] = useState<{ reason: string; tries: number } | null>(null);

  const requireFolder = () => {
    if (!draft.folderId) throw new Error('자료를 넣을 폴더가 없어요');
    return draft.folderId;
  };
  // 처음 상태가 'upload'라 다시 시도할 때만 호출하는 쪽에서 phase를 되돌린다
  const run = async () => {
    if (running.current || canceled.current) return;
    running.current = true;
    let sent: Parameters<typeof api.content.createMaterial>[0] | null = null;
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
      registering.current = true;
      // 보낸 요청(번호 · 본문)을 남겨 둔다: 취소한 뒤 응답이 유실되면 같은 요청으로 결과를 되찾아 멈춘다
      sent = {
        requestId: useDraft.getState().getCreationId(),
        folderId: requireFolder(),
        kind: draft.kind,
        source: draft.source,
        title: draft.title.trim() || defaultTitle(draft.kind, draft.files[0]?.name, draft.source),
        description: draft.description,
        blobUrls: [...blobs.current],
        avatarItemId: draft.avatar,
      };
      const r = await api.content.createMaterial(sent);
      if (canceled.current) {
        // 등록 중에 취소했다. 요청 번호는 취소할 때 이미 떼어 냈다(doCancel) — 여기서 다시 지우면 그사이 다시 올린
        // 새 초안의 번호를 지운다. 늦게 받은 작업만 멈춘다(실패하면 다시 보내고, 끝내 못 멈추면 알린다)
        void cancelLateJob(r.job._id);
        return;
      }
      handled.current = false;
      setMaterialId(r.material._id);
      setJob(r.job);
      setPhase('ai');
    } catch (e) {
      // 등록 중에 취소했는데 응답이 유실됐다: 서버에 저장됐을 수 있으니 같은 요청으로 결과를 되찾아 작업을 멈춘다
      if (canceled.current && sent && isUncertain(e)) void cancelLostRegistration(sent);
      if (!canceled.current && !(e instanceof NetworkError))
        setUploadFail((f) => ({ reason: uploadFailReason(e), tries: (f?.tries ?? 0) + 1 }));
      if (!canceled.current)
        setPhase(
          e instanceof Error && 'code' in e && e.code === 'MATERIAL_REGISTRATION_UNCERTAIN'
            ? 'uncertain'
            : e instanceof NetworkError
              ? 'paused'
              : 'failed',
        );
    } finally {
      registering.current = false;
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

  // 작업이 바뀔 때마다(처음 등록 · 다시 시도) 그 작업의 진행 상황을 구독한다. 다시 시도는 같은 작업 id를
  // 다시 쓰므로 횟수로 다시 구독한다. 소켓이 다시 연결되면 훅이 다시 구독한다
  const [retries, setRetries] = useState(0);
  useAiJobSubscription(job?._id, retries);

  useSocket(
    'ai:progress',
    (p) => {
      if (p.jobId !== job?._id) return;
      setJob((j) => (j ? { ...j, progress: p.progress, status: p.status, step: p.step } : j));
    },
    [job?._id],
  );
  const finish = (done: AiJob) => {
    // 취소를 보내는 중에 끝났으면 기억해 두었다가, 취소가 실패하면 이어 처리한다
    if (cancelling.current && ['succeeded', 'failed', 'canceled'].includes(done.status))
      doneWhileCancelling.current = done;
    if (
      canceled.current ||
      handled.current ||
      !['succeeded', 'failed', 'canceled'].includes(done.status)
    )
      return;
    handled.current = true;
    setJob(done);
    if (done.status === 'succeeded') {
      // 서버 푸시를 받는 기기면 서버가 같은 알림을 보낸다(#560)
      if (bg.current && notify && !pushRegistered())
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
      setRetries((n) => n + 1);
      setPhase('ai');
      setAttempts(1);
    },
  });
  const doCancel = async () => {
    if (!job) {
      canceled.current = true;
      abort.current.abort();
      // 등록 요청이 아직 오가는 중이면 그 요청 번호를 지금 떼어 낸다. 남겨 두면 곧바로 다시 올릴 때 같은 번호의
      // 진행 중 요청을 함께 받아(registerMaterial), 옛 등록을 멈추려는 취소가 새로 올린 작업까지 멈춘다
      if (registering.current) useDraft.getState().set({});
      // 아직 서버에 없다: 초안을 그대로 두고 고른 원본 화면으로 돌아가 바로 확인 · 다시 올릴 수 있게 한다
      router.replace(pickedScreen(draft.kind, draft.source));
      return;
    }
    if (cancelling.current) return;
    cancelling.current = true;
    // 취소를 보내는 동안 끝나도 결과 화면으로 넘어가지 않게 막아 둔다(실패하면 풀고 그 결과를 이어 처리한다)
    canceled.current = true;
    try {
      await api.ai.cancel(job._id);
    } catch {
      // 서버에 닿지 않았으면 작업은 계속 돈다 — 취소했다고 하지 않고 이 화면에 남아 다시 누를 수 있게 한다
      canceled.current = false;
      cancelling.current = false;
      setCancel(false);
      toast('변환을 취소하지 못했어요. 연결을 확인하고 다시 눌러 주세요');
      const done = doneWhileCancelling.current;
      doneWhileCancelling.current = null;
      if (done) finish(done);
      return;
    }
    abort.current.abort();
    // 원본은 서버의 폴더에 남는다. 그 폴더로 가서 바로 보이게 한다(폴더별 자료 수 · 순서도 새로 읽는다)
    const folder = draft.folderId;
    qc.invalidateQueries({ queryKey: ['materials'] });
    qc.invalidateQueries({ queryKey: ['folders'] });
    useDraft.getState().reset();
    router.dismissTo(
      folder ? { pathname: '/(tabs)/note/folder/[id]', params: { id: folder } } : '/(tabs)/note',
    );
    toast('정리를 취소했어요. 원본은 이 폴더에 남겨 뒀어요');
  };

  // 기다리지 않고 폴더로: 서버는 계속 정리하고, 끝나면 전역에서 알려 준다(stores/bg-jobs)
  const leaveToFolder = () => {
    if (!job) return;
    canceled.current = true;
    abort.current.abort();
    useBgJobs.getState().add({
      jobId: job._id,
      kind: 'material',
      title: draft.title.trim() || defaultTitle(draft.kind, draft.files[0]?.name, draft.source),
    });
    const folder = draft.folderId;
    qc.invalidateQueries({ queryKey: ['materials'] });
    qc.invalidateQueries({ queryKey: ['folders'] });
    useDraft.getState().reset();
    router.dismissTo(
      folder ? { pathname: '/(tabs)/note/folder/[id]', params: { id: folder } } : '/(tabs)/note',
    );
    toast('정리가 끝나면 알려 드릴게요');
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
  // 올린 자료가 모두 합쳐 50쪽을 넘었다: 다시 시도해도 같으니 나눠 올리라고 알린다
  const tooManyPages = job?.error === ERROR_CODES.TOO_MANY_PAGES;
  // 등록 전(작업이 없을 때)은 올리기 화면: 원 그래프가 업로드를 0→100%로 보여 주고,
  // 다 올려 서버가 작업을 받은 뒤에야 변환 화면(작업 진행률)으로 넘어간다
  const uploading = !job;
  const pct = uploading ? uploadPct : (job?.progress ?? 0);
  const step = uploading ? 0 : stageOf(job?.step, pct);
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
          <SmoothProgress value={pct} />
          <Text className="mt-3 text-body font-bold text-ink">
            {uploading ? '원본을 올리고 있어요' : TITLE[draft.kind]}
          </Text>
          <Text className="text-footnote text-sub">
            {uploading
              ? `${Math.min(uploaded + 1, draft.files.length)} / ${draft.files.length}개 · 다 올리면 변환을 시작해요`
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
        {phase === 'ai' && job && (
          <View className="mt-8 px-4">
            <Btn kind="outline" onPress={leaveToFolder}>
              폴더에서 기다리기
            </Btn>
            <Text className="mt-2 text-center text-caption2 text-sub">
              다른 화면을 써도 정리는 계속되고, 끝나면 알려 드려요
            </Text>
          </View>
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
        body="다시 시도하면 같은 등록 키로 보내서 같은 자료를 중복 등록하지 않고 이어서 등록해요. 학습자료 목록에서 먼저 확인할 수도 있어요."
        primary="다시 시도"
        onPrimary={() => {
          void run();
        }}
        onClose={() => {}}
        secondary={checking ? '목록 확인 중…' : '학습자료에서 확인'}
        onSecondary={() => {
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
      {/* 서버에 등록되기 전에 실패하면 저장할 원본 자료가 서버에 없으므로 「원본만 저장」 대신 나가기를 둔다.
          다시 시도가 곧바로 또 실패해도 같은 창만 되풀이되지 않게 이유와 횟수를 보여 준다 */}
      <Alert
        open={phase === 'failed' && !credit && !materialId && !job}
        title="자료를 올리지 못했어요"
        body={`${uploadFail?.reason ?? '서버에 올리지 못했어요.'}\n원본은 이 기기에 그대로 있어요.${
          (uploadFail?.tries ?? 0) > 1 ? '\n계속 안 되면 나가서 나중에 다시 올려 주세요.' : ''
        }`}
        secondary="나가기"
        onSecondary={() => router.back()}
        primary="다시 시도"
        onPrimary={() => {
          setPhase('upload');
          void run();
        }}
      />
      <Alert
        open={phase === 'failed' && !credit && (!!materialId || !!job)}
        title={tooManyPages ? `${MATERIAL_MAX_FILES}쪽이 넘는 자료예요` : '정리에 실패했어요'}
        body={
          tooManyPages
            ? `한 노트는 ${MATERIAL_MAX_FILES}쪽까지 정리할 수 있어요.\nPDF를 ${MATERIAL_MAX_FILES}쪽 이하로 나눠 올려 주세요. 원본은 그대로 있어요.`
            : `원본은 그대로 있어요.\n다시 시도하거나 원본만 저장할 수 있어요.`
        }
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
        title={job ? '변환을 취소할까요?' : '올리기를 멈출까요?'}
        body={
          job
            ? '올린 원본은 폴더에 남겨 둘게요. 취소하면 그 폴더로 이동해요.'
            : '아직 서버에 저장하지 않았어요. 고른 원본 화면으로 돌아가요.'
        }
        secondary={job ? '계속 변환' : '계속 올리기'}
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

// 저장 전 미리보기라 「원본 보기」 · 「이 노트로 퀴즈 풀기」는 두지 않는다(저장한 뒤 상세 화면에 있다).
// 실기기 피드백 2026-11-20, 필기 · 녹음 · 문서 모두 같은 규칙
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
  // 다시 만들기: 서버가 새 작업을 넣고, 성공할 때까지 노트는 지금 결과 그대로다(실패하면 지금 결과가 남는다)
  const [askRegen, setAskRegen] = useState(false);
  const [regenJob, setRegenJob] = useState<string | null>(null);
  const regen = useMutation({
    mutationFn: () => api.content.regenerate(id),
    onSuccess: ({ job }) => setRegenJob(job._id),
    // 하루 한도(429) · 이미 다시 만드는 중(409)은 서버 문구 그대로
    onError: (e) =>
      toast(e instanceof ApiError ? e.message : '다시 만들지 못했어요. 연결을 확인해 주세요'),
  });
  useEffect(() => {
    if (!regenJob) return;
    let over = false;
    const t = setInterval(async () => {
      try {
        const j = await api.ai.job(regenJob);
        if (over || !['succeeded', 'failed', 'canceled'].includes(j.status)) return;
        over = true;
        setRegenJob(null);
        // 노트 조회가 끝난 작업의 결과를 옮긴다
        await m.refetch();
        // 녹음 플레이어는 슬라이드 · 대본을 따로(['recording', id]) 불러오므로, 옮긴 뒤 그것도 새로 읽는다
        if (j.status === 'succeeded')
          await qc.invalidateQueries({ queryKey: ['recording', id], exact: true });
        toast(
          j.status === 'succeeded'
            ? '결과를 새로 만들었어요'
            : '다시 만들지 못했어요. 지금 결과는 그대로예요',
        );
      } catch {
        // 연결이 잠깐 끊겨도 다음 확인에서 이어 본다
      }
    }, 1500);
    return () => {
      over = true;
      clearInterval(t);
    };
  }, [regenJob]); // eslint-disable-line react-hooks/exhaustive-deps
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
          <View className="gap-2">
            <Btn loading={save.isPending} disabled={!!regenJob} onPress={() => save.mutate()}>
              학습자료에 저장
            </Btn>
            <Btn
              kind="cream"
              loading={regen.isPending || !!regenJob}
              disabled={save.isPending}
              onPress={() => setAskRegen(true)}
            >
              다시 만들기
            </Btn>
          </View>
        }
      >
        {regenJob && (
          <View className="mb-3">
            <AiPending
              what="다시 만들기"
              hint="새 결과가 나오면 바로 바꿔 보여 드려요. 그때까지 지금 결과는 그대로예요."
            />
          </View>
        )}
        {mat.kind === 'handwriting' && (
          <>
            <Header title="노트 정리 완료" large={false} />
            <View className="mb-3 flex-row items-center gap-2">
              <Text className="text-title3 font-bold text-ink">{mat.title}</Text>
            </View>
            <NoteBody sections={mat.summary?.sections ?? []} diagrams={mat.diagrams} />
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
            />
          </>
        )}
      </Screen>
      <Alert
        open={askRegen}
        tone="sun"
        title="결과를 다시 만들까요?"
        body="새 결과가 나오면 지금 결과는 사라져요. 다시 만들기는 하루 3번까지 할 수 있어요."
        secondary="그대로 두기"
        onSecondary={() => setAskRegen(false)}
        primary="다시 만들기"
        onPrimary={() => {
          setAskRegen(false);
          regen.mutate();
        }}
      />
    </Canvas>
  );
}

type Section = { heading: string; body: string };
/** 섹션 하나에 놓을 도식: 본문 앞(before), 본문 n번째 줄(0부터) 뒤(after) */
export type PlacedDiagrams = { before: Diagram[]; after: Map<number, Diagram[]> };

/** 편집기 표시(# · -)와 앞뒤 공백을 뺀 줄 */
const plainLine = (line: string) =>
  line
    .trim()
    .replace(/^(?:# |- )/, '')
    .trim();

/**
 * 필기 도식(FR-19)을 섹션 본문의 줄 사이에 놓는다. after 와 같은 줄을 앞 도식을 놓은 줄부터 찾아 그 뒤에(같은 앵커는 차례대로 쌓임).
 * after 가 null 이면 첫 섹션 맨 앞, 고친 글에서 그 줄을 못 찾으면 마지막 섹션 끝
 */
export function placeDiagrams(sections: Section[], diagrams: NoteDiagram[]): PlacedDiagrams[] {
  const out = sections.map((): PlacedDiagrams => ({ before: [], after: new Map() }));
  const lines = sections.map((s) => s.body.split('\n').map(plainLine));
  const put = (si: number, li: number, d: Diagram) =>
    out[si]!.after.set(li, [...(out[si]!.after.get(li) ?? []), d]);
  let at = { s: 0, l: 0 }; // 마지막으로 놓은 줄. 같은 앵커가 이어지면 그 줄 뒤에 차례로 쌓는다
  for (const { after, diagram } of diagrams) {
    if (!sections.length) break;
    if (after === null) {
      out[0]!.before.push(diagram);
      continue;
    }
    const want = plainLine(after);
    let found: { s: number; l: number } | null = null;
    for (let si = at.s; si < sections.length && !found; si += 1) {
      const from = si === at.s ? at.l : 0;
      const li = lines[si]!.indexOf(want, from);
      if (li >= 0) found = { s: si, l: li };
    }
    if (found) {
      put(found.s, found.l, diagram);
      at = found;
    } else {
      const last = sections.length - 1;
      put(last, lines[last]!.length - 1, diagram);
    }
  }
  return out;
}

/** 섹션마다 카드 하나. 필기 도식(diagrams)은 본문 줄 사이에 밝은 도식으로 그린다 */
export const NoteBody = ({
  sections,
  diagrams = [],
}: {
  sections: Section[];
  diagrams?: NoteDiagram[];
}) => {
  const placed = placeDiagrams(sections, diagrams);
  return (
    <View className="gap-3">
      {sections.map((s, i) => (
        // 제목이 같은(또는 빈) 섹션이 있어도 겹치지 않게 순서로 구분한다
        <View key={i} testID="note-section">
          <Card className="p-5">
            <Text className="text-subhead font-bold text-ink">{s.heading}</Text>
            <RichBody body={s.body} diagrams={placed[i]!} />
          </Card>
        </View>
      ))}
    </View>
  );
};

const Drawn = ({ list }: { list: Diagram[] | undefined }) =>
  (list ?? []).map((d, i) => <RecordingDiagram key={i} diagram={d} tone="paper" />);

/** 편집기 툴바가 넣는 표시(# 제목 · - 목록 · **굵게** · [글](주소))를 기호 없이 그린다 */
function RichBody({ body, diagrams }: { body: string; diagrams: PlacedDiagrams }) {
  return (
    <View className="mt-0.5 gap-0.5">
      <Drawn list={diagrams.before} />
      {body.split('\n').map((line, i) => (
        <Fragment key={i}>
          {line.startsWith('# ') ? (
            <Text className="mt-1 text-callout font-bold text-ink">
              <Inline text={line.slice(2)} />
            </Text>
          ) : (
            <Text className="text-caption text-ink/70">
              {line.startsWith('- ') ? (
                <>
                  {'• '}
                  <Inline text={line.slice(2)} />
                </>
              ) : (
                <Inline text={line} />
              )}
            </Text>
          )}
          <Drawn list={diagrams.after.get(i)} />
        </Fragment>
      ))}
    </View>
  );
}

const INLINE = /\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]*)\)/g;

/** 한 줄 안의 **굵게** · [글](주소). 주소는 http(s)만 연다 */
function Inline({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1] !== undefined)
      parts.push(
        <Text key={m.index} className="font-bold text-ink">
          {m[1]}
        </Text>,
      );
    else {
      const url = m[3]!;
      parts.push(
        <Text
          key={m.index}
          accessibilityRole="link"
          onPress={() => void Linking.openURL(url).catch(() => toast('링크를 열지 못했어요'))}
          className="text-brand underline"
        >
          {m[2]}
        </Text>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

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

/** 등록 전 실패 이유: 서버 응답 코드로 짧게(네트워크 끊김은 paused로 따로 다룬다) */
function uploadFailReason(e: unknown) {
  // 올리기 전 기기 검사(형식 · 용량)나 Blob 응답 오류는 상태 코드가 없다: 그 이유를 그대로 보여 준다(#508)
  if (e instanceof UploadError) return e.message;
  const status = (e as { status?: number } | null)?.status;
  if (status === 404) return '서버가 아직 자료를 받을 준비가 안 됐어요.';
  if (status === 503) return '서버의 파일 저장소에 연결하지 못했어요.';
  if (status === 413) return '파일이 너무 커서 올리지 못했어요.';
  return '서버에 올리지 못했어요.';
}

function SmoothProgress({ value }: { value: number }) {
  const shown = useSmoothProgress(value);
  return (
    <>
      <View className="h-36 w-36 items-center justify-center rounded-full border-4 border-mint">
        <Pie value={shown} size={112} />
      </View>
      <Text className="mt-2 text-title2 font-bold text-brand">{Math.floor(shown)}%</Text>
    </>
  );
}
