import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// 아바타 3D의 음영 · 부품 합치기. GL · React Native 없이 three만 써서
// 앱(Avatar3D)과 상점 썸네일을 굽는 스크립트(scripts/item-thumbs)가 같은 모습을 그린다

/** 왼쪽 위에서 빛이 드는 공 음영(matcap). 부품 색이 곱해진다 */
export function matcap(size = 64) {
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const nx = (x / (size - 1)) * 2 - 1;
      const ny = (y / (size - 1)) * 2 - 1; // 아래가 +(텍스처 v는 위로)
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const light = Math.max(0, -0.45 * nx + 0.55 * ny + 0.7 * nz); // 빛: 왼쪽 위 앞
      const rim = Math.pow(1 - nz, 3) * 0.12;
      const v = Math.min(255, Math.round((0.62 + 0.42 * light + rim) * 235));
      const i = (y * size + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = v;
      px[i + 3] = 255;
    }
  const tex = new THREE.DataTexture(px, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** 따로 움직이는 부품. 나머지는 한 덩어리로 합친다 */
const MOVING = new Set(['eyeL', 'eyeR', 'mouth']);

/**
 * 머리의 움직이지 않는 부품(얼굴 · 귀 · 머리카락 · 볼)을 색을 꼭짓점에 담아 한 메시로 합치고,
 * 모든 부품을 음영 그림(matcap) 재질로 바꾼다. 부품이 많은 아바타(긴 머리 · 곱슬)는 expo-gl에서
 * 프레임이 화면에 오르지 않았는데, 그리기를 눈 · 입 · 얼굴 넷으로 줄이니 모두 그려졌다(시뮬레이터)
 */
export function bake(root: THREE.Object3D, shade: THREE.Texture) {
  root.updateMatrixWorld(true);
  const head = root.getObjectByName('head') ?? root;
  const toHead = head.matrixWorld.clone().invert();
  const parts: THREE.BufferGeometry[] = [];
  const still: THREE.Mesh[] = [];
  head.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const color = (mesh.material as THREE.MeshStandardMaterial).color;
    if (MOVING.has(mesh.name)) {
      mesh.material = new THREE.MeshMatcapMaterial({ color, matcap: shade });
      return;
    }
    const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    g.applyMatrix4(toHead.clone().multiply(mesh.matrixWorld));
    const n = g.getAttribute('position').count;
    const rgb = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) rgb.set([color.r, color.g, color.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    for (const name of Object.keys(g.attributes))
      if (!['position', 'normal', 'color'].includes(name)) g.deleteAttribute(name);
    parts.push(g);
    still.push(mesh);
  });
  for (const m of still) m.removeFromParent();
  const merged = mergeGeometries(parts);
  if (merged)
    head.add(
      new THREE.Mesh(merged, new THREE.MeshMatcapMaterial({ vertexColors: true, matcap: shade })),
    );
}
