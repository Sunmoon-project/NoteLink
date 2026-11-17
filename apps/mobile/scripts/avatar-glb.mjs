// 상점 아바타(이모지)를 3D 모델(assets/avatar/<id>.glb)로 만든다. 모양을 바꾸면 다시 실행:
//   node apps/mobile/scripts/avatar-glb.mjs
// 이모지처럼 얼굴만 만든다: 피부색 · 머리 모양을 옮긴다.
// 삼각형은 모델당 3,000개 아래로: 넘으면 expo-gl(시뮬레이터)에서 프레임이 화면에 오르지 않았다(약 3,800개)(src/lib/local/catalog.ts SHOP · BASE_AVATAR).
// 앱(Avatar3D)은 이름으로 부품을 찾아 움직인다: head(끄덕임 · 갸웃) · eyeL · eyeR(깜빡임) · mouth(말하기)
import { Buffer } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

// GLTFExporter(binary)는 브라우저의 FileReader로 Blob을 읽는다
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((b) => ((this.result = b), this.onloadend?.()));
  }
  readAsDataURL(blob) {
    blob.arrayBuffer().then((b) => {
      this.result = `data:${blob.type};base64,${Buffer.from(b).toString('base64')}`;
      this.onloadend?.();
    });
  }
};

// 이모지 피부색(🏻 · 🏼 · 🏽)
const SKIN = { light: '#f6d6bf', mediumLight: '#e6b893', medium: '#c48a62' };

/** id → 이모지 특징 */
const AVATARS = {
  base: { emoji: '🧑🏻', skin: SKIN.light, hair: '#3a2a20', style: 'short' },
  saebyeok: { emoji: '🧑🏽', skin: SKIN.medium, hair: '#1d1714', style: 'crop' },
  jihoo: {
    emoji: '👨🏻',
    skin: SKIN.light,
    hair: '#1f1a17',
    style: 'part',
  },
  bora: { emoji: '👧🏻', skin: SKIN.light, hair: '#5a3822', style: 'pigtails' },
  haneul: { emoji: '👩🏻', skin: SKIN.light, hair: '#2a1d17', style: 'long' },
  narae: {
    emoji: '👩🏼‍🦱',
    skin: SKIN.mediumLight,
    hair: '#7a4524',
    style: 'curly',
  },
};

const mat = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
const mesh = (geo, color, name, [x, y, z] = [0, 0, 0]) => {
  const m = new THREE.Mesh(geo, mat(color));
  m.name = name;
  m.position.set(x, y, z);
  return m;
};
const ball = (r, w = 20, h = 14) => new THREE.SphereGeometry(r, w, h);

function hair(head, a) {
  // 정수리를 덮는 바탕 머리. 앞머리 선이 이마 위에 오도록 살짝 뒤로 기울인다
  const top = Math.PI * (a.style === 'crop' ? 0.36 : 0.44);
  const cap = mesh(
    new THREE.SphereGeometry(0.655, 24, 10, 0, Math.PI * 2, 0, top),
    a.hair,
    'hair',
    [0, 0.66, -0.03],
  );
  cap.rotation.x = -0.28;
  head.add(cap);
  if (a.style === 'part') {
    // 가르마: 한쪽으로 넘긴 앞머리
    const fringe = mesh(ball(0.3, 16, 10), a.hair, 'fringe', [-0.22, 1.04, 0.32]);
    fringe.scale.set(1.3, 0.45, 0.7);
    fringe.rotation.z = 0.35;
    head.add(fringe);
  }
  if (a.style === 'pigtails') {
    for (const s of [-1, 1]) {
      const tail = mesh(ball(0.2, 12, 8), a.hair, `pigtail${s}`, [s * 0.68, 0.62, -0.12]);
      tail.scale.set(0.9, 1.3, 0.9);
      head.add(tail);
      head.add(mesh(ball(0.06, 10, 8), '#f2c94c', `band${s}`, [s * 0.58, 0.78, -0.08]));
    }
  }
  if (a.style === 'long') {
    // 등 뒤로 내려오는 생머리 + 얼굴 옆 머리
    // 캡슐 형상은 expo-gl에서 프레임이 화면에 오르지 않아(시뮬레이터) 늘린 구로 만든다
    const back = mesh(ball(0.6, 16, 10), a.hair, 'hairBack', [0, 0.5, -0.3]);
    back.scale.set(1.08, 1.15, 0.6);
    head.add(back);
    for (const s of [-1, 1]) {
      const strand = mesh(ball(0.15, 10, 8), a.hair, `strand${s}`, [s * 0.57, 0.36, 0.1]);
      strand.scale.set(0.8, 2.4, 0.8);
      head.add(strand);
    }
  }
  if (a.style === 'curly') {
    // 곱슬: 작은 공을 정수리 둘레에 겹쳐 올린다. 앞쪽은 이마 위로 올려 눈을 가리지 않게
    for (let i = 0; i < 16; i++) {
      const t = (i / 16) * Math.PI * 2;
      const front = Math.sin(t) > 0.2; // 얼굴 쪽
      const r = front ? 0.42 : i % 2 ? 0.5 : 0.6;
      const up = front ? 1.08 : i % 2 ? 0.98 : 0.84;
      head.add(
        mesh(ball(0.18, 12, 8), a.hair, `curl${i}`, [Math.cos(t) * r, up, Math.sin(t) * r - 0.08]),
      );
    }
    for (const s of [-1, 1])
      head.add(mesh(ball(0.2, 12, 8), a.hair, `curlSide${s}`, [s * 0.62, 0.62, -0.12]));
  }
}

function build(a) {
  const root = new THREE.Group();
  root.name = 'tutor';

  // 머리: 피벗을 목에 두어 끄덕임이 자연스럽게
  const head = new THREE.Group();
  head.name = 'head';
  head.position.set(0, -0.2, 0);
  root.add(head);
  const face = mesh(ball(0.62, 22, 14), a.skin, 'face', [0, 0.62, 0]);
  face.scale.set(1, 0.96, 0.92);
  head.add(face);
  for (const s of [-1, 1]) head.add(mesh(ball(0.1, 10, 8), a.skin, `ear${s}`, [s * 0.6, 0.6, 0]));
  hair(head, a);

  for (const [side, x] of [
    ['L', -0.21],
    ['R', 0.21],
  ]) {
    const eye = mesh(ball(0.075, 12, 8), '#1f2421', `eye${side}`, [x, 0.66, 0.53]);
    eye.scale.set(1, 1.3, 0.6);
    head.add(eye);
    const cheek = mesh(ball(0.08, 10, 8), '#f2a99a', `cheek${side}`, [x * 1.55, 0.5, 0.47]);
    cheek.scale.set(1.3, 0.6, 0.4);
    head.add(cheek);
  }
  // 입: 납작한 타원. 앱이 scale.y를 바꿔 여닫는다
  const mouth = mesh(ball(0.09, 14, 8), '#7a2e2e', 'mouth', [0, 0.44, 0.55]);
  mouth.scale.set(1.4, 0.35, 0.5);
  head.add(mouth);
  return root;
}

const dir = join(dirname(fileURLToPath(import.meta.url)), '../assets/avatar');
mkdirSync(dir, { recursive: true });
for (const [id, a] of Object.entries(AVATARS)) {
  const scene = new THREE.Scene();
  scene.add(build(a));
  const glb = await new GLTFExporter().parseAsync(scene, { binary: true });
  writeFileSync(join(dir, `${id}.glb`), Buffer.from(glb));
  let tris = 0;
  scene.traverse((o) => {
    if (o.isMesh) tris += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3;
  });
  console.log(`${a.emoji} ${id}.glb ${glb.byteLength} bytes, ${tris} triangles`);
}
