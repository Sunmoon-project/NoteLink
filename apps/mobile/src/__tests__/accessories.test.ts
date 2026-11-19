import * as THREE from 'three';
import { ACCESSORIES, accessoryId, attachAccessories } from '../features/tutor/accessories';

const tris = (o: THREE.Object3D) => {
  let n = 0;
  o.traverse((m) => {
    const g = (m as THREE.Mesh).geometry;
    if (g) n += (g.index?.count ?? g.getAttribute('position').count) / 3;
  });
  return n;
};

describe('악세서리', () => {
  it('앱 id와 서버 고정 시드 id(7~11) 모두 같은 악세서리로, 모르는 id는 null', () => {
    expect(accessoryId('roundGlasses')).toBe('roundGlasses');
    expect(accessoryId('6e6f74656c696e6b73680007')).toBe('roundGlasses');
    expect(accessoryId('6e6f74656c696e6b73680008')).toBe('sunglasses');
    expect(accessoryId('6e6f74656c696e6b73680009')).toBe('beanie');
    expect(accessoryId('6e6f74656c696e6b73680010')).toBe('gradCap');
    expect(accessoryId('6e6f74656c696e6b73680011')).toBe('redScarf');
    expect(accessoryId('6e6f74656c696e6b73680006')).toBeNull(); // 바다 테마
    expect(accessoryId('nope')).toBeNull();
  });

  it('5개, 칸은 안경 둘 · 모자 둘 · 목도리 하나', () => {
    expect(Object.fromEntries(Object.entries(ACCESSORIES).map(([k, a]) => [k, a.slot]))).toEqual({
      roundGlasses: 'glasses',
      sunglasses: 'glasses',
      beanie: 'hat',
      gradCap: 'hat',
      redScarf: 'scarf',
    });
  });

  it('expo-gl이 버티게 작게: 각 400개 · 모두 합쳐 1,500개 이하의 삼각형', () => {
    const counts = Object.values(ACCESSORIES).map((a) => tris(a.build()));
    for (const c of counts) expect(c).toBeLessThanOrEqual(400);
    expect(counts.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1500);
  });

  it('조명 재질(Standard)이나 캡슐 없이 색만 가진 메시로 만든다(bake가 matcap으로 합친다)', () => {
    for (const a of Object.values(ACCESSORIES))
      a.build().traverse((m) => {
        const mesh = m as THREE.Mesh;
        if (!mesh.isMesh) return;
        expect(mesh.material).toBeInstanceOf(THREE.MeshBasicMaterial);
        expect(mesh.geometry).not.toBeInstanceOf(THREE.CapsuleGeometry);
      });
  });

  it('머리에 칸마다 하나만 붙인다(같은 칸이 둘이면 뒤의 것), 모르는 id는 무시', () => {
    const head = new THREE.Group();
    attachAccessories(head, ['roundGlasses', 'beanie', 'sunglasses', 'nope'], 'base');
    expect(head.children.map((c) => c.name).sort()).toEqual(['acc-beanie', 'acc-sunglasses']);
  });

  it('곱슬머리(나래)는 모자를 더 높이 씌운다', () => {
    const y = (avatar: string) => {
      const head = new THREE.Group();
      attachAccessories(head, ['beanie'], avatar);
      return head.children[0]!.position.y;
    };
    expect(y('narae')).toBeGreaterThan(y('base'));
  });
});
