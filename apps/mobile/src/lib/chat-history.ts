import type { Message } from '@notelink/shared';

const PAGE_SIZE = 50;

/** 서버 페이지는 오래된 순서로 정렬되며, 앞 페이지의 첫 ID보다 오래된 기록을 이어 읽는다. */
export async function loadCompleteChatHistory(
  fetchPage: (before?: string) => Promise<Message[]>,
  isCurrent: () => boolean = () => true,
): Promise<Message[]> {
  const pages: Message[][] = [];
  const seen = new Set<string>();
  let before: string | undefined;
  for (;;) {
    const page = await fetchPage(before);
    // 한 페이지로 끝나는 이전 기록은 오프라인에서도 보여 준다.
    // 여러 페이지는 부분 결과를 확정하지 않고 재연결 후 처음부터 다시 읽는다.
    if (!isCurrent() && (pages.length > 0 || page.length >= PAGE_SIZE)) {
      throw new Error('채팅 동기화가 중단됐어요');
    }
    pages.push(page);
    if (page.length < PAGE_SIZE) break;
    const next = page[0]?._id;
    if (!next || seen.has(next) || next === before)
      throw new Error('채팅 기록을 이어서 읽을 수 없어요');
    seen.add(next);
    before = next;
  }
  return [
    ...new Map(
      pages
        .reverse()
        .flat()
        .map((message) => [message._id, message]),
    ).values(),
  ];
}
