export type InterestCategory = { _id: string; name: string; parentId: string | null };

/** 부모가 있으면 경로를 표시하며, 손상된 순환 참조에도 무한 반복하지 않는다. */
export function interestLabels(categories: InterestCategory[]): Map<string, string> {
  const byId = new Map(categories.map((category) => [category._id, category]));
  return new Map(
    categories.map((category) => {
      const names: string[] = [];
      const seen = new Set<string>();
      let current: InterestCategory | undefined = category;
      while (current && !seen.has(current._id)) {
        seen.add(current._id);
        names.unshift(current.name);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      return [category._id, names.join(' › ')];
    }),
  );
}

/** 관심 분야 요약: 아는 분야는 이름으로, 서버에서 사라진 분야는 「사용할 수 없는 분야 N개」 하나로 묶는다 */
export function interestSummary(ids: string[], labels: Map<string, string>) {
  const known = ids.flatMap((id) => labels.get(id) ?? []);
  const unknown = ids.length - known.length;
  return [...known, ...(unknown ? [`사용할 수 없는 분야 ${unknown}개`] : [])].join(' · ');
}
