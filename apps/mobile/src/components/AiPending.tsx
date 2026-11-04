import { View } from 'react-native';
import { Sparkles } from 'lucide-react-native';
import { Text } from './text';
import { C, ICON } from '@/theme';

/** AI 정리 · 생성이 서버를 기다리는 동안 보여 주는 안내 (FR-65-05) */
export function AiPending({ what, hint }: { what: string; hint?: string }) {
  return (
    <View className="flex-row gap-3 rounded-2xl bg-mint p-4">
      <Sparkles size={ICON.md} color={C.brand} />
      <View className="flex-1">
        <Text className="text-subhead font-semibold text-ink">
          {what}은(는) AI 서버를 기다리고 있어요
        </Text>
        <Text className="mt-0.5 text-footnote text-sub">
          {hint ?? '서버가 연결되면 자동으로 이어서 처리돼요.'}
        </Text>
      </View>
    </View>
  );
}
