import { router, useSitemap, type SitemapType } from 'expo-router';
import { toast } from '@/stores/toast';

const normalizePath = (path: string) =>
  (path.split(/[?#]/)[0] ?? '/').replace(/\/\([^/]+\)/g, '').replace(/\/+$/, '') || '/';

/** 독립적으로 병합되는 기능의 실제 화면이 등록됐는지 확인한다. */
export function featureRouteExists(sitemap: SitemapType | null, path: string): boolean {
  if (!sitemap) return false;
  return (
    (!sitemap.isInternal &&
      typeof sitemap.href === 'string' &&
      normalizePath(sitemap.href) === normalizePath(path)) ||
    sitemap.children.some((child) => featureRouteExists(child, path))
  );
}

export function useFeatureNavigation() {
  const sitemap = useSitemap();
  return (
    href: Parameters<typeof router.push>[0],
    method: 'push' | 'replace' | 'navigate' = 'push',
    requiredPath?: string,
  ): boolean => {
    const path = typeof href === 'string' ? href : href.pathname;
    if (
      !featureRouteExists(sitemap, path) ||
      (requiredPath !== undefined && !featureRouteExists(sitemap, requiredPath))
    ) {
      toast('이 기능은 준비 중이에요');
      return false;
    }
    router[method](href);
    return true;
  };
}
