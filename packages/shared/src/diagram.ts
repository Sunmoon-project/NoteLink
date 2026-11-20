import { DiagramKind, type Diagram } from './schemas.js';

/**
 * 받은 도식 값을 그릴 수 있는 모양으로 거른다(서버가 보낼 때 · 앱이 그리기 전에 같이 쓴다).
 * 모르는 kind · 핵심어 2개 미만 · 빈 글이거나 글이 아닌 핵심어가 있으면 도식 전체를 null(그리지 않음).
 * 관계는 범위 밖 · 정수가 아님 · 자기 자신 · 중복인 것만 뺀다(처리기 _parse_relations 와 같은 규칙)
 */
export function diagramOf(raw: unknown): Diagram | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { kind, terms, relations } = raw as Record<string, unknown>;
  const k = DiagramKind.safeParse(kind);
  if (!k.success || !Array.isArray(terms) || terms.length < 2) return null;
  if (terms.some((t) => typeof t !== 'string' || !t.trim())) return null;
  const n = terms.length;
  const seen = new Set<string>();
  const pairs: [number, number][] = [];
  for (const r of Array.isArray(relations) ? relations : []) {
    if (!Array.isArray(r) || r.length !== 2) continue;
    const [a, b] = r as unknown[];
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) continue;
    if ((a as number) < 0 || (a as number) >= n || (b as number) < 0 || (b as number) >= n)
      continue;
    if (seen.has(`${a}>${b}`)) continue;
    seen.add(`${a}>${b}`);
    pairs.push([a as number, b as number]);
  }
  return { kind: k.data, terms: terms.map((t: string) => t.trim()), relations: pairs };
}
