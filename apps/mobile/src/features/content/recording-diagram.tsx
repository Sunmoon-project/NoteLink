import { Fragment } from 'react';
import { View } from 'react-native';
import { ArrowRight, CornerDownRight } from 'lucide-react-native';
import { diagramOf, type Diagram } from '@notelink/shared';
import { Text } from '@/components/text';
import { ICON } from '@/theme';

// 녹음 요약 슬라이드의 도식(FR-23). AI가 만든 구조(kind · terms · relations)를 칩과 화살표로 그린다.
// 어두운 슬라이드 카드(bg-night) 안에 붙으므로 흰 글 · 반투명 흰 칩을 쓴다

const ARROW = 'rgba(255,255,255,0.6)';
const KIND_NAME: Record<Diagram['kind'], string> = {
  sequence: '순서',
  contrast: '대비',
  hierarchy: '포함',
  cause: '인과',
  list: '나열',
};

/** 대비: 관계 [왼, 오]로 짝짓고(한 핵심어는 한 번만), 관계가 없으면 앞 절반 · 뒤 절반. 짝 못 지은 핵심어는 차례로 짝짓는다 */
export function contrastRows(d: Diagram): [string, string | undefined][] {
  const used = new Set<number>();
  const rows: [string, string | undefined][] = [];
  for (const [a, b] of d.relations) {
    if (used.has(a) || used.has(b)) continue;
    used.add(a).add(b);
    rows.push([d.terms[a]!, d.terms[b]]);
  }
  const rest = d.terms.filter((_, i) => !used.has(i));
  if (!rows.length) {
    const half = Math.ceil(rest.length / 2);
    return rest.slice(0, half).map((t, i) => [t, rest[half + i]]);
  }
  for (let i = 0; i < rest.length; i += 2) rows.push([rest[i]!, rest[i + 1]]);
  return rows;
}

/**
 * 흐름(순서 · 인과) 한 줄: 이어지는 관계(A→B, B→C)는 한 사슬 「A → B → C」. 갈라지면(A→B, A→C) 새 줄을
 * 「A에서 → C」로 시작하고(from), 이미 그린 핵심어로 모이면(A→C, B→C) 줄 끝에 to 로 이름만 붙인다.
 * 칩(terms)은 핵심어마다 한 번만. from · to 는 앞에서 그린 칩을 가리키는 흐린 글이다
 */
export type FlowRow = { from?: string; terms: string[]; to?: string };

/** 순서 · 인과 줄. 관계가 없으면 순서는 핵심어 차례대로, 인과는 마지막이 결과(나머지 → 마지막) */
export function flowRows(d: Diagram): FlowRow[] {
  const n = d.terms.length;
  const rel: [number, number][] = d.relations.length
    ? d.relations
    : d.kind === 'cause'
      ? d.terms.slice(0, -1).map((_, i) => [i, n - 1])
      : d.terms.slice(1).map((_, i) => [i, i + 1]);
  const next = (i: number) => rel.filter(([a]) => a === i).map(([, b]) => b);
  const hasIn = new Set(rel.map(([, b]) => b));
  const seen = new Set<number>();
  const rows: FlowRow[] = [];
  const walk = (start: number, from?: number) => {
    const row: FlowRow = { terms: [] };
    if (from !== undefined) row.from = d.terms[from];
    rows.push(row);
    const branches: [number, number][] = [];
    for (let cur: number | undefined = start; cur !== undefined;) {
      seen.add(cur);
      row.terms.push(d.terms[cur]!);
      const outs = next(cur);
      const fresh = outs.filter((b) => !seen.has(b));
      const at = cur;
      cur = fresh[0];
      branches.push(...fresh.slice(1).map((b): [number, number] => [at, b]));
      if (cur === undefined && outs.length) row.to = d.terms[outs[0]!];
    }
    for (const [a, b] of branches) if (!seen.has(b)) walk(b, a);
  };
  // 들어오는 관계가 없는 핵심어부터(앞 차례 먼저), 고리로만 이어진 것 · 관계에 없는 것은 그다음
  d.terms.forEach((_, i) => !hasIn.has(i) && !seen.has(i) && walk(i));
  d.terms.forEach((_, i) => !seen.has(i) && walk(i));
  return rows;
}

/** 포함: 관계 [위, 아래]로 나무를 만들어 위에서부터 깊이와 함께. 부모는 첫 관계만, 고리로 못 닿은 핵심어는 맨 위 */
export function hierarchyRows(d: Diagram): { term: string; depth: number }[] {
  const parent = new Map<number, number>();
  for (const [a, b] of d.relations) if (!parent.has(b)) parent.set(b, a);
  const out: { term: string; depth: number }[] = [];
  const seen = new Set<number>();
  const visit = (i: number, depth: number) => {
    if (seen.has(i)) return;
    seen.add(i);
    out.push({ term: d.terms[i]!, depth });
    d.terms.forEach((_, j) => parent.get(j) === i && visit(j, depth + 1));
  };
  d.terms.forEach((_, i) => !parent.has(i) && visit(i, 0));
  d.terms.forEach((_, i) => visit(i, 0));
  return out;
}

const flowLabel = (d: Diagram, then: string) =>
  flowRows(d)
    .map((r) => [r.from, ...r.terms, r.to].filter(Boolean).join(then))
    .join('; ');

/** 화면 읽기 도구가 읽을 도식 내용 */
export function diagramLabel(d: Diagram): string {
  const body = {
    sequence: () => flowLabel(d, ', 다음 '),
    contrast: () =>
      contrastRows(d)
        .map(([a, b]) => (b ? `${a} 대 ${b}` : a))
        .join(', '),
    hierarchy: () =>
      hierarchyRows(d)
        .map((r) => (r.depth ? `${r.depth}단계 ${r.term}` : r.term))
        .join(', '),
    cause: () => flowLabel(d, ', 그래서 '),
    list: () => d.terms.join(', '),
  }[d.kind]();
  return `도식(${KIND_NAME[d.kind]}): ${body}`;
}

function Term({ children, strong }: { children: string; strong?: boolean }) {
  return (
    <View
      className={
        strong ? 'rounded-full bg-white/20 px-2.5 py-1' : 'rounded-full bg-white/10 px-2.5 py-1'
      }
    >
      <Text className="text-caption2 font-semibold text-white">{children}</Text>
    </View>
  );
}

const Right = () => <ArrowRight size={ICON.xs} color={ARROW} />;

const Ref = ({ children }: { children: string }) => (
  <Text className="text-caption2 text-white/50">{children}</Text>
);

/** 순서 · 인과: 줄마다 칩을 화살표로 잇는다(넘치면 줄바꿈). 인과는 마지막 결과 칩을 진하게 */
function Flow({ d }: { d: Diagram }) {
  return (
    <View className="gap-1.5">
      {flowRows(d).map((r, i) => (
        <View key={i} className="flex-row flex-wrap items-center gap-1.5">
          {r.from ? (
            <>
              <CornerDownRight size={ICON.xs} color={ARROW} />
              <Ref>{r.from}</Ref>
              <Right />
            </>
          ) : null}
          {r.terms.map((t, j) => (
            <Fragment key={j}>
              {j > 0 && <Right />}
              <Term strong={d.kind === 'cause' && !r.to && j === r.terms.length - 1 && j > 0}>
                {t}
              </Term>
            </Fragment>
          ))}
          {r.to ? (
            <>
              <Right />
              <Ref>{r.to}</Ref>
            </>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function Body({ d }: { d: Diagram }) {
  switch (d.kind) {
    case 'sequence':
    case 'cause':
      return <Flow d={d} />;
    case 'contrast':
      return (
        <View className="gap-1.5">
          {contrastRows(d).map(([a, b], i) => (
            <View key={i} className="flex-row items-center gap-2">
              <View className="flex-1 items-end">
                <Term>{a}</Term>
              </View>
              <Text className="text-caption2 text-white/40">vs</Text>
              <View className="flex-1 items-start">{b ? <Term>{b}</Term> : null}</View>
            </View>
          ))}
        </View>
      );
    case 'hierarchy':
      return (
        <View className="gap-1">
          {hierarchyRows(d).map((r, i) => (
            <View
              key={i}
              className="flex-row items-center gap-1"
              style={{ paddingLeft: r.depth * 16 }}
            >
              {r.depth > 0 && <CornerDownRight size={ICON.xs} color={ARROW} />}
              <Term strong={r.depth === 0}>{r.term}</Term>
            </View>
          ))}
        </View>
      );
    case 'list':
      return (
        <View className="gap-1">
          {d.terms.map((t, i) => (
            <View key={i} className="flex-row items-center gap-2">
              <View className="h-1.5 w-1.5 rounded-full bg-white/60" />
              <Text className="text-caption2 text-white">{t}</Text>
            </View>
          ))}
        </View>
      );
  }
}

/** 슬라이드 도식. 값이 없거나 그릴 수 없으면(모르는 kind · 핵심어 부족 등) 아무것도 그리지 않는다 */
export function RecordingDiagram({ diagram }: { diagram: unknown }) {
  const d = diagramOf(diagram);
  if (!d) return null;
  return (
    <View
      testID="recording-diagram"
      accessible
      accessibilityLabel={diagramLabel(d)}
      className="mt-3 rounded-xl border border-white/10 p-3"
    >
      <Text className="mb-2 text-caption2 text-white/40">{KIND_NAME[d.kind]}</Text>
      <Body d={d} />
    </View>
  );
}
