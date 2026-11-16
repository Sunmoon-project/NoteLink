import { Stack } from 'expo-router';
import { CameraScreen } from '@/features/content/capture';

export default function FeatureRoute() {
  return (
    <>
      <Stack.Screen options={{ animation: 'fade' }} />
      <CameraScreen />
    </>
  );
}
