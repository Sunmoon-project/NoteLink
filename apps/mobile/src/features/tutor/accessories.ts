import * as THREE from 'three';

/**
 * 아바타 선생님 치장(상점 hat · glasses · scarf). 외부 3D 파일 없이 얼굴(scripts/avatar-glb.mjs)과 같은
 * 말랑한 도형으로 런타임에 만든다. 좌표는 머리(head) 기준: 얼굴 중심 (0, 0.62, 0) 반지름 0.62,
 * 눈 y 0.66 · z 0.53, 귀 x ±0.6. Avatar3D가 bake 전에 head에 붙여 움직이지 않는 부품과 한 메시로 합친다
 * (그리기 횟수 그대로). 재질은 색만 쓰고(bake가 matcap으로 바꾼다), 캡슐은 expo-gl에서 안 그려져 쓰지 않는다.
 * 색 hex는 화면 색(tokens.js)이 아니라 상품 재질이라 얼굴(avatar-glb.mjs)처럼 여기에 둔다.
 * GL이 안 되는 기기의 2D 얼굴(FlatFace)에는 치장을 그리지 않는다(의도)
 */
export type Slot = 'hat' | 'glasses' | 'scarf';

const part = (geo: THREE.BufferGeometry, color: string, [x, y, z]: [number, number, number]) => {
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
  m.position.set(x, y, z);
  return m;
};
const group = (...parts: THREE.Object3D[]) => {
  const g = new THREE.Group();
  g.add(...parts);
  return g;
};
/** 안경테: 코 받침 + 귀까지 다리 */
const frame = (color: string) => {
  const bridge = part(
    new THREE.CylinderGeometry(0.014, 0.014, 0.17, 6, 1, true),
    color,
    [0, 0.69, 0.6],
  );
  bridge.rotation.z = Math.PI / 2;
  const legs = [-1, 1].map((s) => {
    const leg = part(new THREE.CylinderGeometry(0.012, 0.012, 0.42, 6, 1, true), color, [
      s * 0.34,
      0.69,
      0.37,
    ]);
    leg.rotation.x = Math.PI / 2;
    return leg;
  });
  return [bridge, ...legs];
};

export const ACCESSORIES: Record<
  string,
  { slot: Slot; name: string; build: () => THREE.Object3D }
> = {
  roundGlasses: {
    slot: 'glasses',
    name: '동그란 안경',
    build: () =>
      group(
        ...[-1, 1].map((s) =>
          part(new THREE.TorusGeometry(0.12, 0.018, 5, 16), '#2b2f33', [s * 0.21, 0.66, 0.6]),
        ),
        ...frame('#2b2f33'),
      ),
  },
  sunglasses: {
    slot: 'glasses',
    name: '선글라스',
    build: () =>
      group(
        ...[-1, 1].map((s) => {
          // 납작한 원판을 앞으로 세운다. 눈(움직이는 부품)을 가리는 게 의도
          const lens = part(new THREE.CylinderGeometry(0.135, 0.135, 0.02, 16), '#16181a', [
            s * 0.21,
            0.66,
            0.61,
          ]);
          lens.rotation.x = Math.PI / 2;
          return lens;
        }),
        ...frame('#16181a'),
      ),
  },
  beanie: {
    slot: 'hat',
    name: '털모자',
    build: () => {
      const dome = part(
        new THREE.SphereGeometry(0.69, 14, 5, 0, Math.PI * 2, 0, Math.PI / 2),
        '#e2a03f',
        [0, 0, 0],
      );
      dome.scale.set(1, 0.85, 0.96);
      const brim = part(new THREE.TorusGeometry(0.66, 0.07, 4, 14), '#c98a2e', [0, 0.02, 0]);
      brim.rotation.x = Math.PI / 2;
      const pom = part(new THREE.SphereGeometry(0.13, 8, 5), '#f4ecd8', [0, 0.62, 0]);
      const hat = group(dome, brim, pom);
      hat.position.set(0, 0.8, -0.02);
      hat.rotation.x = -0.2; // 이마 쪽을 조금 내려 쓴다
      return hat;
    },
  },
  gradCap: {
    slot: 'hat',
    name: '학사모',
    build: () => {
      const skull = part(
        new THREE.CylinderGeometry(0.44, 0.5, 0.26, 16, 1, true),
        '#22262b',
        [0, 0, 0],
      );
      const board = part(new THREE.BoxGeometry(1.0, 0.05, 1.0), '#22262b', [0, 0.14, 0]);
      board.rotation.y = Math.PI / 4;
      const cord = part(
        new THREE.CylinderGeometry(0.012, 0.012, 0.32, 6, 1, true),
        '#f2c94c',
        [0.5, -0.02, 0.2],
      );
      const tassel = part(new THREE.SphereGeometry(0.05, 8, 5), '#f2c94c', [0.5, -0.2, 0.2]);
      const hat = group(skull, board, cord, tassel);
      hat.position.set(0, 1.12, -0.04);
      hat.rotation.x = -0.12;
      return hat;
    },
  },
  redScarf: {
    slot: 'scarf',
    name: '빨간 목도리',
    build: () => {
      const wrap = part(new THREE.TorusGeometry(0.4, 0.11, 6, 18), '#c0392b', [0, 0, 0]);
      wrap.rotation.x = Math.PI / 2;
      wrap.scale.set(1, 0.9, 1);
      const tail = part(new THREE.BoxGeometry(0.16, 0.36, 0.06), '#a93226', [0.2, -0.2, 0.36]);
      tail.rotation.z = 0.15;
      // 턱 아래. 머리에 붙어 끄덕임과 함께 움직인다(몸통이 없어서 자연스럽다)
      const scarf = group(wrap, tail);
      scarf.position.set(0, 0.04, 0.02);
      return scarf;
    },
  },
};

/**
 * 머리카락이 높은 아바타는 모자가 묻히지 않게 더 올린다(scripts/avatar-glb.mjs의 곱슬 정수리 ≈ 1.26).
 * 양갈래(bora)는 머리 옆으로 달려 정수리가 기본과 같아 올리지 않는다
 */
const HAT_LIFT: Record<string, number> = { narae: 0.1 };

/** 서버 상품은 id가 ObjectId라 고정 시드 id(apps/api shop-seed.ts idOf 7~11)로도 찾는다 */
const SEED_IDS: Record<string, string> = {
  '6e6f74656c696e6b73680007': 'roundGlasses',
  '6e6f74656c696e6b73680008': 'sunglasses',
  '6e6f74656c696e6b73680009': 'beanie',
  '6e6f74656c696e6b73680010': 'gradCap',
  '6e6f74656c696e6b73680011': 'redScarf',
};
/** 상품 id → 악세서리 id. 모르면 null(판매가 끝났거나 새 앱에만 있는 상품은 조용히 빼고 그린다) */
export const accessoryId = (itemId: string): string | null =>
  ACCESSORIES[itemId] ? itemId : (SEED_IDS[itemId] ?? null);

/** 읽어 주는 이름: 「털모자 · 동그란 안경」. 없으면 빈 글자 */
export const accessoryNames = (ids: string[]) =>
  bySlot(ids)
    .map((id) => ACCESSORIES[id]!.name)
    .join(' · ');

/** 칸마다 하나만 남긴다(같은 칸이 둘이면 뒤의 것). 모르는 id는 뺀다 */
const bySlot = (ids: string[]) => {
  const m = new Map<Slot, string>();
  for (const id of ids) {
    const a = ACCESSORIES[id];
    if (a) m.set(a.slot, id);
  }
  return [...m.values()];
};

/** 미리보기 모습: 지금 장착한 것에 이 상품을 더하고, 같은 칸의 기존 것은 뺀다 */
export function previewLook(current: string[], item: string): string[] {
  const slot = ACCESSORIES[item]?.slot;
  if (!slot) return current;
  return [...current.filter((id) => ACCESSORIES[id]?.slot !== slot), item];
}

/** 머리에 악세서리를 붙인다(bake 전, GL 밖에서). avatar: 3D 모델 이름(modelId) */
export function attachAccessories(head: THREE.Object3D, ids: string[], avatar: string) {
  for (const id of bySlot(ids)) {
    const a = ACCESSORIES[id]!;
    const o = a.build();
    o.name = `acc-${id}`;
    if (a.slot === 'hat') o.position.y += HAT_LIFT[avatar] ?? 0;
    head.add(o);
  }
}
