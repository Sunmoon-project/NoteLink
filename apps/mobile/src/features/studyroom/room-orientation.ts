import { useCallback } from 'react';
import { useFocusEffect } from 'expo-router';
import * as ScreenOrientation from 'expo-screen-orientation';

/** Only the focused room allows rotation; other screens keep the app's portrait policy. */
export function useRoomOrientation() {
  useFocusEffect(
    useCallback(() => {
      // DEFAULT supports portrait + both landscape directions on iPhone without requiring upside-down.
      void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.DEFAULT).catch(() => {});
      return () => {
        void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(
          () => {},
        );
      };
    }, []),
  );
}
