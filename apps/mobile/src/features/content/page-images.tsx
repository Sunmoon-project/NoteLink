import { useState } from 'react';
import { Image as RNImage, Pressable, ScrollView, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import type { Material } from '@notelink/shared';
import { Text } from '@/components/text';
import { api } from '@/lib/api';

const mb = (bytes: number) => (bytes > 0 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : '');

type PageTurn = 'swipe' | 'scroll' | 'tap';
/** 설정 「페이지 넘김 방식」. 불러오기 전 · 실패 때는 위아래 스크롤 */
export function usePageTurn(): PageTurn {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me.get() });
  return me.data?.settings.pageTurn ?? 'scroll';
}

/** 한 페이지: 두 손가락으로 확대 (FR-25-02) */
function PageImage({ p, width }: { p: NonNullable<Material['pages']>[number]; width?: number }) {
  return (
    <View className="overflow-hidden rounded-card bg-white" style={width ? { width } : undefined}>
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
  );
}

/**
 * 원본 페이지 이미지. 설정 「페이지 넘김 방식」을 따른다: 위아래 스크롤(모두 이어서) · 좌우 스와이프(한 장씩
 * 넘김) · 탭해서 넘기기(한 장씩, 왼쪽 · 오른쪽 절반을 누르면 앞 · 뒤 장)
 */
export function PageImages({
  pages,
  mode = 'scroll',
}: {
  pages: NonNullable<Material['pages']>;
  mode?: PageTurn;
}) {
  const [w, setW] = useState(0);
  const [at, setAt] = useState(0);
  if (!pages.length)
    return <Text className="mt-4 text-center text-footnote text-sub">원본 이미지가 없어요</Text>;
  if (mode === 'scroll' || pages.length === 1)
    return (
      <View className="gap-3">
        {pages.map((p) => (
          <PageImage key={p.pageNo} p={p} />
        ))}
      </View>
    );
  const count = (
    <Text className="mt-2 text-center text-caption text-sub" accessibilityLiveRegion="polite">
      {at + 1} / {pages.length}
    </Text>
  );
  if (mode === 'swipe')
    return (
      <View testID="page-swipe" onLayout={(e) => setW(e.nativeEvent.layout.width)}>
        <ScrollView
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          accessibilityLabel="원본 페이지, 좌우로 넘겨요"
          onMomentumScrollEnd={(e) => w && setAt(Math.round(e.nativeEvent.contentOffset.x / w))}
        >
          {w > 0 && pages.map((p) => <PageImage key={p.pageNo} p={p} width={w} />)}
        </ScrollView>
        {count}
      </View>
    );
  const page = pages[Math.min(at, pages.length - 1)]!;
  return (
    <View onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${page.pageNo}페이지 원본, 오른쪽을 누르면 다음 장 · 왼쪽은 앞 장`}
        onPress={(e) =>
          setAt((i) =>
            e.nativeEvent.locationX < w / 2
              ? Math.max(0, i - 1)
              : Math.min(pages.length - 1, i + 1),
          )
        }
      >
        <PageImage p={page} />
      </Pressable>
      {count}
    </View>
  );
}
