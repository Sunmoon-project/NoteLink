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
