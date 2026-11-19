import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Text } from '@/components/text';
import { Canvas, Header, Screen } from '@/components/ui';
import { HELP_DOCS } from '@/features/profile/help-docs';
import { LEGAL_DOCS, type LegalDoc } from './legal-docs';

// 약관과 도움말(자주 묻는 질문 · 사용 가이드)을 같은 화면으로 보여 준다
const DOCS: Record<string, LegalDoc> = { ...LEGAL_DOCS, ...HELP_DOCS };

/** 약관 · 개인정보 처리방침 · 마케팅 수신 동의 전문과 도움말. 가입 전(약관 동의)과 로그인 뒤(설정) 모두에서 연다 */
export function LegalDocScreen() {
  const { doc } = useLocalSearchParams<{ doc?: string }>();
  const d = (doc && Object.hasOwn(DOCS, doc) ? DOCS[doc] : undefined) ?? LEGAL_DOCS.service;
  return (
    <Canvas>
      <Screen>
        <Header title={d.title} large={false} />
        {!!d.updated && <Text className="mt-1 text-caption text-sub">{d.updated}</Text>}
        {d.intro && <Text className="mt-4 text-footnote leading-6 text-ink">{d.intro}</Text>}
        {d.sections.map((s) => (
          <View key={s.heading} className="mt-6">
            <Text className="text-body font-bold text-ink">{s.heading}</Text>
            {s.body.map((p) => (
              <Text key={p} className="mt-2 text-footnote leading-6 text-ink/80">
                {p}
              </Text>
            ))}
          </View>
        ))}
        <View className="h-10" />
      </Screen>
    </Canvas>
  );
}
