import { View } from 'react-native';
import { router } from 'expo-router';
import { ChevronRight, PenLine } from 'lucide-react-native';
import type { Material } from '@notelink/shared';
import { Text } from '@/components/text';
import { Card } from '@/components/ui';
import { C, ICON } from '@/theme';

/**
 * 노트에서 바로 퀴즈로(노트 상세 · 정리 완료 화면). 정리가 끝난 노트만 보인다.
 * 퀴즈 생성 화면은 서버가 정리 끝에 미리 만들어 둔 첫 퀴즈(quiz_pregen)를 이어받아 곧바로 준비된다
 */
export function QuizFromNote({ material, className }: { material: Material; className?: string }) {
  if (material.processing?.status !== 'done') return null;
  return (
    <Card
      tone="white"
      onPress={() =>
        router.push({
          pathname: '/play/gen',
          params: { materialId: material._id, title: material.title },
        })
      }
      className={`flex-row items-center px-4 py-3 ${className ?? ''}`}
    >
      <View className="mr-3 h-9 w-9 items-center justify-center rounded-full bg-mint">
        <PenLine size={ICON.sm} color={C.brand} />
      </View>
      <View className="flex-1">
        <Text className="text-subhead font-semibold text-ink">이 노트로 퀴즈 풀기</Text>
        <Text className="text-caption text-sub">정리한 내용으로 문제를 만들어 바로 풀어요</Text>
      </View>
      <ChevronRight size={ICON.sm} color={C.sub} />
    </Card>
  );
}
