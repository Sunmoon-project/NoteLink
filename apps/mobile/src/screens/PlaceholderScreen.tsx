import { Pressable, StyleSheet, View } from 'react-native';
import { useSitemap } from 'expo-router';
import { featureRouteExists, useFeatureNavigation } from '@/lib/feature-navigation';
import { Text } from '@/components/text';

type Props = {
  title: string;
};

/** 아직 만들지 않은 화면 자리 표시 */
export function PlaceholderScreen({ title }: Props) {
  const sitemap = useSitemap();
  const openFeature = useFeatureNavigation();
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>
      {title === '홈' && featureRouteExists(sitemap, '/friends') && (
        <Pressable
          accessibilityRole="button"
          onPress={() => openFeature('/friends')}
          className="mt-4 rounded-xl bg-mint px-4 py-3"
        >
          <Text className="text-subhead text-brand">친구 · 채팅</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 20, fontWeight: '600' },
});
