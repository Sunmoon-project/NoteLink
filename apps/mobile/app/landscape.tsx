import { Stack } from 'expo-router';
import { LandscapeScreen } from '@/features/session/summary';

export default function FeatureRoute() {
  return (
    <>
      <Stack.Screen options={{ animation: 'fade', orientation: 'landscape' }} />
      <LandscapeScreen />
    </>
  );
}
