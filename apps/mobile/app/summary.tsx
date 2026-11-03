import { Stack } from 'expo-router';
import { SummaryScreen } from '@/features/session/summary';

export default function FeatureRoute() {
  return (
    <>
      <Stack.Screen options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }} />
      <SummaryScreen />
    </>
  );
}
