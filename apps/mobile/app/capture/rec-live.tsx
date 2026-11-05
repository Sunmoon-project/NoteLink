import { Stack } from 'expo-router';
import { RecLiveScreen } from '@/features/content/capture';

export default function FeatureRoute() {
  return (
    <>
      <Stack.Screen options={{ animation: 'fade' }} />
      <RecLiveScreen />
    </>
  );
}
