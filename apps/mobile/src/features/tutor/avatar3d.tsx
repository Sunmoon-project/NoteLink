import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AccessibilityInfo, View } from 'react-native';
import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { GLView, type ExpoWebGLRenderingContext } from 'expo-gl';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { C } from '@/theme';

// Hermes에는 FinalizationRegistry가 없다(three의 WebGLRenderer가 GPU 자원 정리에 씀).
// 화면을 떠날 때 renderer.dispose()로 직접 정리하므로 등록만 받는 대체로 둔다
globalThis.FinalizationRegistry ??= class {
  register() {}
  unregister() {}
} as unknown as FinalizationRegistryConstructor;

/** idle: 숨 쉬듯 흔들림 · thinking: 고개 갸웃 · talking: 입을 여닫고 끄덕임 */
/** happy: 눌렀을 때의 반응(눈웃음 · 넓은 입 · 고개 흔들기) · surprised: 놀람(큰 눈 · 동그란 입 · 뒤로 젖힘)
 * · wink: 한쪽 눈을 감고 웃음 */
export type Mood = 'idle' | 'thinking' | 'talking' | 'happy' | 'surprised' | 'wink';
/** full: 대화 무대(여백을 두고 얼굴 전체) · head: 떠다니는 버튼(얼굴을 꽉 채움) */
export type Framing = 'full' | 'head';

/* eslint-disable @typescript-eslint/no-require-imports */
/** 상점 아바타 id → 3D 모델(scripts/avatar-glb.mjs가 이모지를 옮겨 만든 GLB) */
const MODELS: Record<string, number> = {
  base: require('../../../assets/avatar/base.glb'),
  saebyeok: require('../../../assets/avatar/saebyeok.glb'),
  jihoo: require('../../../assets/avatar/jihoo.glb'),
  bora: require('../../../assets/avatar/bora.glb'),
  haneul: require('../../../assets/avatar/haneul.glb'),
  narae: require('../../../assets/avatar/narae.glb'),
};
/* eslint-enable @typescript-eslint/no-require-imports */
export const modelId = (avatarId?: string | null) =>
  avatarId && avatarId in MODELS ? avatarId : 'base';

/**
 * 모델 파일을 한 번만 읽어 둔다. 장면 해석은 GL 없이 되므로 GLView를 띄우기 전에 끝낸다:
 * expo-gl은 onContextCreate 안에서 await한 뒤 그린 프레임을 화면에 올리지 않았다(시뮬레이터에서 확인)
 */
const files = new Map<string, Promise<ArrayBuffer>>();
function loadModel(id: string) {
  let p = files.get(id);
  if (!p) {
    p = (async () => {
      const asset = Asset.fromModule(MODELS[id]!);
      await asset.downloadAsync();
      return new File(asset.localUri ?? asset.uri).arrayBuffer();
    })();
    p.catch(() => files.delete(id)); // 다음에 다시 시도
    files.set(id, p);
  }
  return p;
}

/** three.js가 찾는 캔버스 대신(expo-gl은 DOM이 없다) */
const fakeCanvas = (w: number, h: number) =>
  ({
    width: w,
    height: h,
    style: {},
    clientHeight: h,
    addEventListener: () => {},
    removeEventListener: () => {},
  }) as unknown as HTMLCanvasElement;

/** 왼쪽 위에서 빛이 드는 공 음영(matcap). 부품 색이 곱해진다 */
function matcap(size = 64) {
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
function bake(root: THREE.Object3D, shade: THREE.Texture) {
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

/** expo-gl과 three의 차이를 메운다(시뮬레이터에서 하나씩 확인. @react-three/fiber/native도 비슷하게 감싼다) */
function patchGl(gl: ExpoWebGLRenderingContext, canvas: HTMLCanvasElement) {
  // 모르는 pixelStorei 값은 걸러 낸다
  const pixelStorei = gl.pixelStorei.bind(gl);
  gl.pixelStorei = (pname, param) => {
    if (pname === gl.UNPACK_FLIP_Y_WEBGL || pname === gl.UNPACK_ALIGNMENT)
      pixelStorei(pname, param);
  };
  // 화면이 실제로는 FBO라 화면용 drawBuffers([BACK]) · bindFramebuffer(null)이 화면을 벗어난다.
  // 렌더 타깃을 쓰지 않으므로 BACK은 첫 색 버퍼로, null 바인딩은 건너뛴다
  const drawBuffers = gl.drawBuffers.bind(gl);
  gl.drawBuffers = (bufs) =>
    drawBuffers(Array.from(bufs, (b) => (b === gl.BACK ? gl.COLOR_ATTACHMENT0 : b)));
  const bindFramebuffer = gl.bindFramebuffer.bind(gl);
  gl.bindFramebuffer = (target, fb) => {
    if (fb) bindFramebuffer(target, fb);
  };
  // 프레임마다 resetState로 GL 상태를 비우는데, resetState가 canvas를 읽는다
  (gl as unknown as { canvas: HTMLCanvasElement }).canvas = canvas;
}

const FRAME_MS = 33;
const approach = (from: number, to: number, k: number) => from + (to - from) * k;
/** 표정별 입 너비(기본 1) */
export const MOUTH_WIDE: Partial<Record<Mood, number>> = { happy: 1.35, wink: 1.2, surprised: 0.6 };
/**
 * 눈을 얼마나 뜰지(원래 높이 대비). 웃을 때는 가늘게(눈웃음), 생각할 때 조금 감고, 놀라면 크게,
 * 윙크는 왼눈(n = 0)만 감는다. 그 밖에는 깜빡임 값(blink)을 따른다
 */
export function eyeOpen(mood: Mood, n: number, blink: number) {
  if (mood === 'happy') return 0.35;
  if (mood === 'thinking') return 0.7;
  if (mood === 'surprised') return 1.35;
  if (mood === 'wink') return n === 0 ? 0.1 : 1;
  return blink;
}
const CAMERA: Record<Framing, { pos: [number, number, number]; at: number }> = {
  full: { pos: [0, 0.5, 3.5], at: 0.44 },
  head: { pos: [0, 0.56, 2.9], at: 0.5 },
};

/**
 * 아바타 선생님 3D(expo-gl + three). 장착한 상점 아바타의 모델을 그린다. 그리기는 GL 쪽에서
 * 프레임마다 하고, mood는 ref로만 읽어 React를 다시 그리지 않는다. 동작 줄이기를 켜면
 * 흔들림 · 끄덕임은 빼고 입 · 표정만 바꾼다. 모델을 못 읽거나 GL을 쓸 수 없으면 2D 얼굴로 대신한다.
 */
export function Avatar3D({
  mood,
  avatarId,
  size = 220,
  framing = 'full',
  background = C.mint,
  onReady,
}: {
  mood: Mood;
  avatarId?: string | null;
  size?: number;
  framing?: Framing;
  /** 둘레와 같은 색으로 칠한다(투명 합성은 expo-gl에서 비어 보였다) */
  background?: string;
  /** 첫 프레임을 그렸거나 2D로 대신했을 때(한 번). 빈 자리가 먼저 움직이지 않게 기다리는 데 쓴다 */
  onReady?: () => void;
}) {
  const id = modelId(avatarId);
  const moodRef = useRef(mood);
  const ready = useRef(onReady);
  useEffect(() => {
    ready.current = onReady;
  });
  // 실패는 그 모델에만: 다른 아바타로 바꾸면 다시 3D로 읽어 본다
  const [failedId, setFailedId] = useState<string | null>(null);
  const failed = failedId === id;
  const [model, setModel] = useState<{ id: string; root: THREE.Group } | null>(null);
  const reduce = useRef(false);
  // 그리기 반복을 멈추는 정리 함수(모델이 바뀌거나 화면을 떠날 때)
  const stop = useRef<(() => void) | null>(null);

  useEffect(() => {
    moodRef.current = mood;
  }, [mood]);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => (reduce.current = v));
  }, []);
  // 아바타 · 구도가 바뀌어 옛 GL 화면을 내리거나 화면을 떠나면 그리기 반복을 바로 멈춘다.
  // 커밋 중에 도는 layout 정리라, 새 GL 화면의 onContextCreate보다 늦게 돌아 새 반복을 멈추는 일이 없다
  useLayoutEffect(() => () => stop.current?.(), [id, framing]);
  useEffect(() => {
    let live = true;
    loadModel(id)
      .then((buf) => new GLTFLoader().parseAsync(buf, ''))
      .then((g) => {
        if (!live) return;
        setModel({ id, root: g.scene });
        // 전에 실패했던 모델을 다시 골라 이번에 읽었으면 2D에서 3D로 돌아온다
        setFailedId((f) => (f === id ? null : f));
      })
      .catch(() => {
        if (!live) return;
        setFailedId(id);
        ready.current?.();
      });
    return () => {
      live = false;
    };
  }, [id]);

  const onContextCreate = (gl: ExpoWebGLRenderingContext, root: THREE.Group) => {
    try {
      stop.current?.();
      const { drawingBufferWidth: w, drawingBufferHeight: h } = gl;
      const canvas = fakeCanvas(w, h);
      patchGl(gl, canvas);
      const renderer = new THREE.WebGLRenderer({
        canvas,
        context: gl as unknown as WebGL2RenderingContext,
      });
      renderer.setPixelRatio(1);
      renderer.setSize(w, h, false);
      renderer.setClearColor(background, 1);
      renderer.outputColorSpace = THREE.SRGBColorSpace;

      const scene = new THREE.Scene();
      const cam = CAMERA[framing];
      const camera = new THREE.PerspectiveCamera(30, w / h, 0.1, 50);
      camera.position.set(...cam.pos);
      camera.lookAt(0, cam.at, 0);
      scene.add(root);
      // 조명을 쓰는 재질(Standard · 직접광)은 expo-gl에서 프레임이 화면에 오르지 않았다.
      // 조명 없이 음영 그림(matcap)으로 입체감을 내고, 부품을 합쳐 그리기 횟수를 줄인다
      if (!root.userData.baked) {
        bake(root, matcap());
        root.userData.baked = true;
      }
      const part = (name: string) => root.getObjectByName(name);
      const head = part('head');
      const eyes = [part('eyeL'), part('eyeR')].filter((e) => !!e);
      const mouth = part('mouth');
      const mouthY = mouth?.scale.y ?? 0.35;
      const mouthX = mouth?.scale.x ?? 1;
      const eyeY = eyes[0]?.scale.y ?? 1.3;

      const start = Date.now();
      let nextBlink = 2500;
      let blinkEnd = 0;
      let frame: ReturnType<typeof setTimeout> | undefined;
      let live = true;
      stop.current = () => {
        live = false;
        clearTimeout(frame);
        renderer.dispose();
        stop.current = null;
      };
      const render = () => {
        if (!live) return;
        const t = (Date.now() - start) / 1000;
        const m = moodRef.current;
        const still = reduce.current;
        if (!still) root.position.y = Math.sin(t * 1.8) * 0.025;
        if (head) {
          head.rotation.z = approach(
            head.rotation.z,
            m === 'thinking'
              ? 0.16
              : m === 'wink'
                ? -0.12
                : m === 'happy' && !still
                  ? Math.sin(t * 7) * 0.14
                  : 0,
            m === 'happy' ? 0.3 : 0.08,
          );
          head.rotation.y = approach(
            head.rotation.y,
            still ? 0 : m === 'idle' ? Math.sin(t * 0.6) * 0.18 : 0,
            0.06,
          );
          head.rotation.x = approach(
            head.rotation.x,
            m === 'surprised' ? -0.12 : still || m !== 'talking' ? 0 : Math.sin(t * 3.2) * 0.05,
            0.3,
          );
        }
        if (mouth) {
          // 말할 때는 두 박자를 섞어 같은 모양이 반복되지 않게
          const open = 0.5 + 0.5 * Math.sin(t * 13) * Math.sin(t * 4.3 + 1);
          mouth.scale.y =
            m === 'talking'
              ? mouthY * (1 + 2.4 * Math.abs(open))
              : m === 'happy'
                ? mouthY * 1.9
                : m === 'surprised'
                  ? mouthY * 3.2
                  : m === 'wink'
                    ? mouthY * 1.5
                    : mouthY;
          mouth.scale.x = approach(mouth.scale.x, mouthX * (MOUTH_WIDE[m] ?? 1), 0.25);
        }
        const ms = t * 1000;
        if (ms > nextBlink) {
          blinkEnd = ms + 130; // 깜빡임 약 0.13초
          nextBlink = ms + 2800 + Math.random() * 2200;
        }
        const blink = ms < blinkEnd ? 0.12 : 1;
        eyes.forEach((e, n) => (e.scale.y = eyeY * eyeOpen(m, n, blink)));

        renderer.render(scene, camera);
        renderer.resetState();
        gl.flush();
        gl.endFrameEXP();
        ready.current?.();
        ready.current = undefined;
        // 약 30fps. 다음 프레임은 이번 프레임을 다 보낸 뒤에 잡는다: 그리기가 느린 환경(시뮬레이터 GL)에서
        // 60fps로 몰아 보내면 프레임이 한 번도 화면에 오르지 않았다. 숨 쉬기 · 입 모양에는 30fps면 충분하다
        frame = setTimeout(render, FRAME_MS);
      };
      render();
    } catch {
      setFailedId(id);
      ready.current?.();
    }
  };

  const loaded = model?.id === id ? model.root : null;
  return (
    <View
      accessibilityLabel="아바타 선생님"
      accessibilityRole="image"
      style={{ width: size, height: size }}
    >
      {failed ? (
        <FlatFace mood={mood} size={size} />
      ) : loaded ? (
        <GLView
          // 아바타를 바꾸면 GL 화면을 새로 만든다
          key={`${id}-${framing}`}
          style={{ width: size, height: size }}
          msaaSamples={0}
          onContextCreate={(gl) => onContextCreate(gl, loaded)}
        />
      ) : null}
    </View>
  );
}

/** GL을 쓸 수 없을 때의 2D 얼굴 */
export function FlatFace({ mood, size }: { mood: Mood; size: number }) {
  const d = size * 0.6;
  return (
    <View className="flex-1 items-center justify-center">
      <View
        className="items-center justify-center rounded-full bg-brand"
        style={{ width: d, height: d }}
      >
        <View className="flex-row items-center gap-5">
          {[0, 1].map((n) => (
            <View
              key={n}
              testID={`flat-eye-${n}`}
              className="w-3 rounded-full bg-white"
              style={{
                height:
                  mood === 'surprised'
                    ? 16
                    : (mood === 'wink' && n === 0) || mood === 'happy'
                      ? 3
                      : 12,
              }}
            />
          ))}
        </View>
        <View
          testID="flat-mouth"
          className="mt-3 rounded-full bg-white"
          style={{
            width: mood === 'happy' ? 28 : mood === 'surprised' ? 12 : 22,
            height: mood === 'talking' ? 10 : mood === 'happy' ? 8 : mood === 'surprised' ? 12 : 4,
          }}
        />
      </View>
    </View>
  );
}
