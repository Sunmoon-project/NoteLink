import { useEffect } from 'react';
import { router } from 'expo-router';

/** 간편 로그인 복귀 주소. Android는 이 주소로 앱이 열린다. 결과는 로그인 화면이 받으므로 그대로 돌아간다 */
export default function AuthCallback() {
  useEffect(() => {
    if (router.canGoBack()) router.back();
  }, []);
  return null;
}
