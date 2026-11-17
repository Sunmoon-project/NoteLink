import { useEffect } from 'react';
import { router } from 'expo-router';

/** 간편 로그인 복귀 주소. Android는 이 주소로 앱이 열린다. 결과는 로그인 화면이 받으므로 그대로 돌아가고, 돌아갈 곳이 없으면 로그인으로 간다 */
export default function AuthCallback() {
  useEffect(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(auth)/login');
  }, []);
  return null;
}
