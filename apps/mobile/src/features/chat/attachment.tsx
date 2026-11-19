import { Image, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import * as WebBrowser from 'expo-web-browser';
import { ChevronRight, FileText, ImageIcon, NotebookPen } from 'lucide-react-native';
import type { Message } from '@notelink/shared';
import { Pressable } from '@/components/press';
import { Text } from '@/components/text';
import { Pop } from '@/components/ui';
import { socket } from '@/lib/socket';
import { uploadToBlob, type LocalFile } from '@/lib/upload';
import { toast } from '@/stores/toast';
import { C, ICON } from '@/theme';

// 채팅 첨부(사진 · PDF): 스터디룸 채팅(#507)과 1:1 채팅(FR-16-03)이 같이 쓴다

/** 서버가 보낸 메시지를 확인해 주기를 기다리는 시간 */
export const ACK_TIMEOUT_MS = 8000;

export type AttachmentKind = 'image' | 'file';
/** 보내는 중인 첨부: 다시 보낼 때 고른 파일 · 이미 올린 주소를 다시 쓴다 */
export type PendingAttachment = { kind: AttachmentKind; file: LocalFile; blobUrl?: string };

/** 보낼 메시지의 기기 쪽 식별자(재전송 때 같은 메시지로 묶는다) */
export const newClientId = (seq: number) =>
  `c${Date.now()}-${seq}-${Math.random().toString(36).slice(2, 10)}`;
/** 이름 없이 고른 사진의 파일 이름 */
const photoName = () => `photo-${Date.now()}.jpg`;

/** 채팅 목록 위 한 줄 미리보기 */
export const previewOf = (m: Message) =>
  m.type === 'image'
    ? '사진'
    : m.type === 'file'
      ? `파일 · ${m.attachment?.name ?? ''}`
      : m.type === 'shared_item'
        ? `노트 · ${m.text ?? ''}`
        : (m.text ?? '공유 자료');

export const sizeLabel = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)}MB`
    : `${Math.max(1, Math.round(bytes / 1024))}KB`;

/** 서명된 읽기 주소(SAS)의 만료 시각(se)이 지났거나 1분 안에 지나는지. se가 없으면 만료되지 않는 주소로 본다 */
export const urlExpired = (url: string, now = Date.now()) => {
  const se = /[?&]se=([^&]+)/.exec(url)?.[1];
  if (!se) return false;
  const at = Date.parse(decodeURIComponent(se));
  return Number.isFinite(at) && at - now < 60_000;
};

/** 사진 · PDF 하나를 고른다. 형식은 파일 이름(확장자)으로 정한다 — 서버가 확장자와 형식이 같은지 본다 */
export async function pickChatFile(kind: AttachmentKind): Promise<LocalFile | undefined> {
  if (kind === 'image') {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
    const a = r.canceled ? undefined : r.assets[0];
    return a && { uri: a.uri, name: a.fileName ?? photoName(), size: a.fileSize };
  }
  const r = await DocumentPicker.getDocumentAsync({
    type: 'application/pdf',
    copyToCacheDirectory: true,
  });
  const a = r.canceled ? undefined : r.assets[0];
  return a && { uri: a.uri, name: a.name, mimeType: a.mimeType, size: a.size };
}

/** 고른 파일을 채팅 경로에 올린 뒤(한 번 올린 주소는 다시 쓴다) 첨부 메시지로 보내고, 서버가 저장한 메시지를 돌려준다 */
export async function sendChatAttachment(
  chatRoomId: string,
  clientId: string,
  entry: PendingAttachment,
): Promise<Message> {
  entry.blobUrl ??= await uploadToBlob(
    entry.kind === 'image' ? 'image' : 'document',
    entry.file,
    undefined,
    undefined,
    'chat',
  );
  const blobUrl = entry.blobUrl;
  return new Promise<Message>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ACK_TIMEOUT_MS);
    socket.emit(
      'chat:send',
      { chatRoomId, clientId, attachment: { blobUrl, kind: entry.kind, name: entry.file.name } },
      (sent) => {
        clearTimeout(timer);
        resolve(sent);
      },
    );
  });
}

/** 보내는 동안 바로 띄울 내 말풍선(기기 파일 주소로 미리 보인다) */
export const pendingMessage = (
  chatRoomId: string,
  senderId: string,
  clientId: string,
  { kind, file }: PendingAttachment,
): Message => ({
  _id: clientId,
  clientId,
  chatRoomId,
  senderId,
  type: kind,
  text: null,
  attachment: { kind, name: file.name, sizeBytes: file.size ?? 0, url: file.uri },
  sharedItemId: null,
  createdAt: new Date().toISOString(),
});

/** 첨부 열기: 읽기 주소가 만료됐으면(1시간) refresh로 새 주소를 받아 연다 */
export async function openChatAttachment(m: Message, refresh: () => Promise<string | undefined>) {
  let url = m.attachment?.url;
  if (!url) return;
  if (urlExpired(url) && !url.startsWith('file:')) {
    url = (await refresh()) ?? url;
    if (urlExpired(url)) return toast('첨부를 다시 불러오지 못했어요. 잠시 뒤 다시 눌러 주세요');
  }
  // 기기 저장 모드의 file:// 첨부는 브라우저가 열지 못한다(iOS는 http(s)만). 공유 시트의 미리보기로 연다(Codex #507 재리뷰)
  if (url.startsWith('file:')) {
    const ok = await Sharing.isAvailableAsync().catch(() => false);
    if (!ok) return toast('이 기기에서는 파일을 열 수 없어요');
    return void (await Sharing.shareAsync(url).catch(() => toast('파일을 열지 못했어요')));
  }
  await WebBrowser.openBrowserAsync(url).catch(() => toast('파일을 열지 못했어요'));
}

/** + 로 여는 첨부 고르기 줄: 사진 · 파일(PDF) */
export function AttachPicker({
  onPick,
  className,
}: {
  onPick: (kind: AttachmentKind) => void;
  className?: string;
}) {
  return (
    <Pop className={className ?? 'flex-row gap-2 rounded-2xl bg-white p-2'}>
      {(
        [
          ['image', ImageIcon, '사진'],
          ['file', FileText, '파일 (PDF)'],
        ] as const
      ).map(([kind, Ic, label]) => (
        <Pressable
          key={kind}
          accessibilityRole="button"
          accessibilityLabel={`${label} 보내기`}
          onPress={() => onPick(kind)}
          className="flex-1 flex-row items-center justify-center gap-2 rounded-xl bg-mint py-3"
        >
          <Ic size={ICON.sm} color={C.brand} />
          <Text className="text-subhead font-semibold text-ink">{label}</Text>
        </Pressable>
      ))}
    </Pop>
  );
}

/** 말풍선: 글 · 사진(눌러서 크게) · 파일(눌러서 열기) · 방에 공유한 노트(눌러서 열기) */
export function ChatBubble({
  m,
  onOpen,
  onStale,
}: {
  m: Message;
  onOpen: (m: Message) => void;
  onStale: () => void;
}) {
  const a = m.attachment;
  const open = () => onOpen(m);
  if (m.type === 'image' && a)
    return (
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={`사진 ${a.name} 크게 보기`}
        onPress={open}
      >
        <Image
          source={{ uri: a.url }}
          className="h-44 w-44 rounded-2xl bg-fill"
          resizeMode="cover"
          onError={() => {
            if (urlExpired(a.url)) onStale();
          }}
        />
      </Pressable>
    );
  if (m.type === 'file' && a)
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`파일 ${a.name} 열기`}
        onPress={open}
        className="max-w-[78%] flex-row items-center gap-2.5 rounded-2xl bg-white px-3 py-2.5"
      >
        <View className="h-9 w-9 items-center justify-center rounded-xl bg-mint">
          <FileText size={ICON.sm} color={C.brand} />
        </View>
        <View className="shrink">
          <Text numberOfLines={1} className="text-footnote font-semibold text-ink">
            {a.name}
          </Text>
          {a.sizeBytes > 0 && (
            <Text className="text-caption2 text-sub">{sizeLabel(a.sizeBytes)}</Text>
          )}
        </View>
      </Pressable>
    );
  // 노트를 방에 공유하면 서버가 남기는 자료 카드(글 = 노트 제목)
  if (m.type === 'shared_item' && m.sharedItemId)
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`공유한 노트 ${m.text ?? ''} 열기`}
        onPress={open}
        className="max-w-[78%] flex-row items-center gap-2.5 rounded-2xl bg-white px-3 py-2.5"
      >
        <View className="h-9 w-9 items-center justify-center rounded-xl bg-mint">
          <NotebookPen size={ICON.sm} color={C.brand} />
        </View>
        <View className="shrink">
          <Text numberOfLines={1} className="text-footnote font-semibold text-ink">
            {m.text || '공유한 노트'}
          </Text>
          <Text className="text-caption2 text-sub">공유한 노트 · 눌러서 열기</Text>
        </View>
        <ChevronRight size={ICON.sm} color={C.sub} />
      </Pressable>
    );
  return (
    <View className="max-w-[78%] rounded-2xl bg-white px-3 py-2">
      {/* 길게 누르면 복사할 수 있게 */}
      <Text selectable className="text-footnote text-ink">
        {m.type === 'image' || m.type === 'file'
          ? '첨부를 불러오지 못했어요'
          : (m.text ?? '공유 자료를 보냈어요')}
      </Text>
    </View>
  );
}
