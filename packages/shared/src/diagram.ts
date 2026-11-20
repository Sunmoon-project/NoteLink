import { DiagramKind, type Diagram } from './schemas.js';

// apps/ai services/recording/pipeline.py 의 DIAGRAM_MIN/MAX_TERMS · DIAGRAM_TERM_MAX_CHARS 와 같은 값(처리기는 넘으면 도식 전체를 버림)
const MIN_TERMS = 2;
const MAX_TERMS = 4;
const TERM_MAX_CHARS = 20;

/**
 * 받은 도식 값을 그릴 수 있는 모양으로 거른다(서버가 보낼 때 · 앱이 그리기 전에 같이 쓴다).
 * 모르는 kind · 핵심어 2~4개가 아님 · 빈 글이거나 글이 아닌 핵심어가 있으면 도식 전체를 null(그리지 않음).
 * 다듬은 핵심어가 20자(글자 수, 처리기와 같이 코드포인트)를 넘어도 null.
 * 관계는 범위 밖 · 정수가 아님 · 자기 자신 · 중복인 것만 뺀다(처리기 _parse_relations 와 같은 규칙)
 */
export function diagramOf(raw: unknown): Diagram | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { kind, terms, relations } = raw as Record<string, unknown>;
  const k = DiagramKind.safeParse(kind);
  if (!k.success || !Array.isArray(terms) || terms.length < MIN_TERMS || terms.length > MAX_TERMS)
    return null;
  if (terms.some((t) => typeof t !== 'string' || !t.trim())) return null;
  const kept: string[] = terms.map((t: string) => t.trim());
  if (kept.some((t) => [...t].length > TERM_MAX_CHARS)) return null;
  const n = kept.length;
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
  return { kind: k.data, terms: kept, relations: pairs };
}
