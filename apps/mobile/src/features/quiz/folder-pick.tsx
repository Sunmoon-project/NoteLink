import { useState } from 'react';
import { View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Folder as FolderIcon } from 'lucide-react-native';
import type { Folder } from '@notelink/shared';
import { Text } from '@/components/text';
import { Btn, Canvas, Card, Empty, Header, Loading, Screen, Search } from '@/components/ui';
import { NetBanner } from '@/components/NetBanner';
import { api } from '@/lib/api';
import { seoul } from '@/lib/dates';
import { C, ICON } from '@/theme';

/**
 * 노트 탭(NoteListScreen)과 같은 학습 폴더 카드 격자. 퀴즈 만들기(#575) · 퀴즈 보관함 · 플래시 카드(#601)의
 * 1단계가 같이 쓴다. 폴더를 누르면 onPick으로 그 폴더의 2단계를 연다
 */
export function FolderGrid({
  folders,
  onPick,
}: {
  folders: (Folder & { materialCount: number })[];
  onPick: (folderId: string) => void;
}) {
  return (
    <View className="mt-6 flex-row flex-wrap justify-between gap-y-5">
      {folders.map((f) => (
        <Card key={f._id} onPress={() => onPick(f._id)} className="w-[47.5%] p-3.5">
          <View className="h-20 items-center justify-center rounded-xl bg-mint">
            <FolderIcon size={ICON.xl} color={C.brand} />
          </View>
          <Text className="mt-3 px-1 text-subhead font-semibold text-ink">{f.title}</Text>
          <Text className="mt-0.5 px-1 pb-1 text-caption2 text-sub">
            {f.subjectName} · {seoul(f.createdAt).getMonth() + 1}/{seoul(f.createdAt).getDate()} ·
            자료 {f.materialCount}개
          </Text>
        </Card>
      ))}
    </View>
  );
}

/**
 * 1단계에서 「전체 보기」를 고르면 넘기는 folderId. 폴더를 지워도(FoldersService.remove) 보관 문제 · 카드는 남고,
 * 폴더 정보가 없는 옛 항목도 있어서 노트를 고르지 않고 전체를 보는 길로 쓴다(#601 Codex 1차)
 */
export const ALL_FOLDERS = 'all';

/** 보관함을 읽을 폴더: 전체 보기 · 빈 값이면 undefined(전체) */
export const boxFolder = (folderId?: string) =>
  folderId && folderId !== ALL_FOLDERS ? folderId : undefined;

/**
 * 퀴즈 보관함 · 플래시 카드(#601) · 유사 퀴즈(#605)의 1단계: 어느 노트(학습 폴더)의 항목을 볼지 고른다.
 * 폴더 목록은 노트 탭 · 퀴즈 만들기와 같은 키로 한 번만 읽는다. 지운 노트의 항목은 「전체 보기」로 본다.
 * 유사 퀴즈는 한 노트의 문제만 고르므로 전체 보기를 두지 않는다(all = false)
 */
export function FolderPickScreen({
  title,
  onPick,
  sub = '어떤 노트를 볼까요?',
  all = true,
}: {
  title: string;
  onPick: (folderId: string) => void;
  sub?: string;
  all?: boolean;
}) {
  const folders = useQuery({ queryKey: ['folders'], queryFn: api.content.folders });
  const [q, setQ] = useState('');
  const list = (folders.data ?? []).filter((f) => f.title.includes(q));
  return (
    <Canvas>
      <Screen>
        <NetBanner />
        <Header title={title} sub={sub} large={false} />
        <Search value={q} onChangeText={setQ} placeholder="노트 검색" />
        {all && (
          <View className="mt-4 flex-row items-center gap-3">
            <Text className="flex-1 text-caption text-sub">
              지운 노트의 항목도 전체 보기에서 볼 수 있어요
            </Text>
            <Btn small kind="outline" onPress={() => onPick(ALL_FOLDERS)}>
              전체 보기
            </Btn>
          </View>
        )}
        {folders.isError && !folders.data && (
          <Empty
            icon={<FolderIcon size={ICON.lg} color={C.brand} />}
            title="노트를 불러오지 못했어요"
            body="연결을 확인하고 다시 시도해 주세요."
          >
            <Btn small loading={folders.isFetching} onPress={() => void folders.refetch()}>
              다시 시도
            </Btn>
          </Empty>
        )}
        {folders.isSuccess && folders.data.length === 0 && (
          <Empty
            icon={<FolderIcon size={ICON.lg} color={C.brand} />}
            title="아직 노트가 없어요"
            body="노트를 올리고 퀴즈를 만들면 노트별로 모여요."
          />
        )}
        {folders.isPending && (
          <View accessible accessibilityLabel="노트를 불러오는 중">
            <Loading />
          </View>
        )}
        {folders.isSuccess && folders.data.length > 0 && list.length === 0 && (
          <Text className="py-16 text-center text-footnote text-sub">찾는 노트가 없어요</Text>
        )}
        <FolderGrid folders={list} onPick={onPick} />
      </Screen>
    </Canvas>
  );
}
