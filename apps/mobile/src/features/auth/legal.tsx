import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Text } from '@/components/text';
import { Canvas, Header, Screen } from '@/components/ui';
import { LEGAL_DOCS, type LegalDocKey } from './legal-docs';

const isKey = (v: unknown): v is LegalDocKey =>
  v === 'service' || v === 'privacy' || v === 'marketing';

/** 약관 · 개인정보 처리방침 · 마케팅 수신 동의 전문. 가입 전(약관 동의)과 로그인 뒤(설정) 모두에서 연다 */
export function LegalDocScreen() {
  const { doc } = useLocalSearchParams<{ doc?: string }>();
  const d = LEGAL_DOCS[isKey(doc) ? doc : 'service'];
  return (
    <Canvas>
      <Screen>
        <Header title={d.title} large={false} />
        <Text className="mt-1 text-caption text-sub">{d.updated}</Text>
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
