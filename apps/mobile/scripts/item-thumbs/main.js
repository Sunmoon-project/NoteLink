// serve.mjs가 띄운 페이지. 아바타 6개 · 치장 5개를 투명 바탕 PNG로 그려 /save로 보낸다
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ACCESSORIES } from '../../src/features/tutor/accessories';
import { bake, matcap } from '../../src/features/tutor/bake';

const AVATARS = ['base', 'saebyeok', 'jihoo', 'bora', 'haneul', 'narae'];
const SIZE = 256; // 화면에서 최대 96pt(3배)
const renderer = new THREE.WebGLRenderer({
  alpha: true,
  antialias: true,
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(1);
renderer.setSize(SIZE, SIZE);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.append(renderer.domElement);

/** 물체가 꽉 차게(여백 6%) 앱과 같은 시야각 30도로 본다. tilt: 위에서 내려다보는 각(라디안) */
function shoot(root, tilt) {
  const scene = new THREE.Scene();
  scene.add(root);
  const box = new THREE.Box3().setFromObject(root);
  const c = box.getCenter(new THREE.Vector3());
  const cam = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
  const place = (d) => {
    cam.position.set(c.x, c.y + Math.sin(tilt) * d, c.z + Math.cos(tilt) * d);
    cam.lookAt(c);
    cam.updateMatrixWorld();
  };
  // 상자 꼭짓점을 화면에 비춰 가장 먼 쪽이 가장자리 94%에 오게 거리를 맞춘다(두 번이면 수렴)
  let d = box.getBoundingSphere(new THREE.Sphere()).radius / Math.sin(THREE.MathUtils.degToRad(15));
  for (let k = 0; k < 3; k++) {
    place(d);
    let far = 0;
    for (const x of [box.min.x, box.max.x])
      for (const y of [box.min.y, box.max.y])
        for (const z of [box.min.z, box.max.z]) {
          const p = new THREE.Vector3(x, y, z).project(cam);
          far = Math.max(far, Math.abs(p.x), Math.abs(p.y));
        }
    d *= far / 0.94;
  }
  place(d);
  renderer.render(scene, cam);
  return new Promise((ok) => renderer.domElement.toBlob(ok, 'image/png'));
}

const save = (name, blob) => fetch(`/save?name=${name}`, { method: 'POST', body: blob });

for (const id of AVATARS) {
  const url = new URL(`../../assets/avatar/${id}.glb`, import.meta.url).href;
  const g = await new GLTFLoader().loadAsync(url);
  bake(g.scene, matcap());
  await save(id, await shoot(g.scene, 0));
}
for (const [id, a] of Object.entries(ACCESSORIES)) {
  const root = new THREE.Group();
  root.add(a.build());
  // 안경은 정면이면 납작해 보여 살짝 돌려 다리가 보이게
  if (a.slot === 'glasses') root.rotation.y = 0.45;
  bake(root, matcap());
  // 목도리는 고리가 보이게 위에서, 모자는 조금 위에서, 안경은 정면
  await save(id, await shoot(root, a.slot === 'scarf' ? 0.6 : a.slot === 'hat' ? 0.25 : 0.15));
}
document.getElementById('status').textContent = 'done';
await fetch('/done');
