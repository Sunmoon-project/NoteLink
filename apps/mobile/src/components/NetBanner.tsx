import { Pressable, View } from 'react-native';
import { Text } from '@/components/text';
import { X } from 'lucide-react-native';
import { useNet } from '@/stores/net';
import { Fade, cx } from './ui';
import { C, ICON } from '@/theme';

// 연결 · 점검 안내 배너 (p.97, p.99, p.101)
const MSG = {
  unstable: ['연결이 불안정해요', '자동으로 다시 연결하는 중이에요', 'bg-sun/25'],
  offline: ['오프라인 모드로 사용 중이에요', '연결되면 자동으로 동기화돼요', 'bg-cream'],
  maintenance: ['서비스 점검 중이에요', '오전 3~4시 · 보기와 타이머는 그대로 써요', 'bg-cream'],
  aiMaintenance: ['AI 기능 점검 중이에요', '요청은 순서대로 처리돼요', 'bg-cream'],
} as const;

export function NetBanner() {
  const { state, set } = useNet();
  if (state === 'ok') return null;
  const [title, body, bg] = MSG[state];
  return (
    <Fade className={cx('mt-2 flex-row items-center rounded-2xl px-4 py-2.5', bg)}>
      <View className="flex-1">
        <Text className="text-footnote font-semibold text-ink">● {title}</Text>
        <Text className="text-caption2 text-sub">{body}</Text>
      </View>
      <Pressable accessibilityLabel="닫기" onPress={() => set('ok')} hitSlop={10}>
        <X size={ICON.sm} color={C.sub} />
      </Pressable>
    </Fade>
  );
}

/** 연결이 불안정할 때 하단에 뜨는 저장 대기 안내 */
export function PendingPill() {
  const state = useNet((s) => s.state);
  if (state !== 'unstable') return null;
  return (
    <View
      pointerEvents="none"
      className="absolute inset-x-8 bottom-4 rounded-full bg-ink px-4 py-2.5"
    >
      <Text className="text-center text-caption font-semibold text-white">
        저장 대기 중 · 연결되면 자동 저장
      </Text>
    </View>
  );
}
