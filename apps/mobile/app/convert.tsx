import { Stack } from 'expo-router';
import { ConvertScreen } from '@/features/content/convert';

export default function FeatureRoute() {
  return (
    <>
      <Stack.Screen options={{ gestureEnabled: false }} />
      <ConvertScreen />
    </>
  );
}
