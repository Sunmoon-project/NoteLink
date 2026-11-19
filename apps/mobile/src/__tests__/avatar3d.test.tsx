// 아바타 3D: 실제 GLB를 읽어 굽고(bake) 그리기 반복을 도는지, 모델 교체 · 로딩 실패 · 화면 떠남에
// 옛 그리기 반복이 바로 멈추는지 본다. GPU 대신 그리기 · 프레임 보내기 호출만 센다
import { act, render, screen } from '@testing-library/react-native';

jest.unmock('../features/tutor/avatar3d');
// 모델 파일은 이름만 넘기고, 읽기(File)에서 실제 GLB를 디스크에서 읽는다
jest.mock('../../assets/avatar/base.glb', () => 'base.glb');
jest.mock('../../assets/avatar/saebyeok.glb', () => 'saebyeok.glb');
jest.mock('../../assets/avatar/jihoo.glb', () => 'jihoo.glb');
jest.mock('../../assets/avatar/bora.glb', () => 'bora.glb');
jest.mock('../../assets/avatar/haneul.glb', () => 'haneul.glb');
jest.mock('../../assets/avatar/narae.glb', () => 'narae.glb');

const mockGl: { props: { onContextCreate: (gl: unknown) => void }; endFrameEXP: jest.Mock }[] = [];
jest.mock('expo-gl', () => {
  const { View } = jest.requireActual('react-native');
  return {
    GLView: (props: { onContextCreate: (gl: unknown) => void }) => {
      mockGl.push({ props, endFrameEXP: jest.fn() });
      return <View testID="gl" />;
    },
  };
});
let mockFail = new Set<string>();
const mockGate: Record<string, Promise<void>> = {};
jest.mock('expo-asset', () => ({
  Asset: {
    fromModule: (m: { testUri?: string } | string) => {
      const uri = typeof m === 'string' ? m : (m.testUri ?? String(m));
      const name = /(\w+)\.glb/.exec(uri)?.[1] ?? 'base';
      return {
        uri: name,
        localUri: name,
        downloadAsync: async () => {
          await mockGate[name];
          if (mockFail.has(name)) throw new Error('download failed');
        },
      };
    },
  },
}));
jest.mock('expo-file-system', () => {
  const fs = jest.requireActual('fs');
  const path = jest.requireActual('path');
  return {
    File: class {
      mockName: string;
      constructor(name: string) {
        this.mockName = name;
      }
      async arrayBuffer() {
        const b = fs.readFileSync(path.resolve('assets/avatar', `${this.mockName}.glb`));
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      }
    },
  };
});
const mockRenderers: { render: jest.Mock; dispose: jest.Mock }[] = [];
jest.mock('three', () => {
  const real = jest.requireActual('three');
  class WebGLRenderer {
    render = jest.fn();
    dispose = jest.fn();
    constructor() {
      mockRenderers.push(this);
    }
    setPixelRatio() {}
    setSize() {}
    setClearColor() {}
    resetState() {}
  }
  return { ...real, WebGLRenderer };
});

// eslint-disable-next-line import/first
import { Avatar3D, cameraFor } from '../features/tutor/avatar3d';

const fakeGl = (i: number) => ({
  drawingBufferWidth: 200,
  drawingBufferHeight: 200,
  pixelStorei() {},
  drawBuffers() {},
  bindFramebuffer() {},
  flush() {},
  endFrameEXP: mockGl[i]!.endFrameEXP,
});
/** i번째로 띄운 GL 화면의 컨텍스트를 만든다(기기에서 GLView가 부르는 것처럼) */
const createContext = (i: number) => act(() => mockGl[i]!.props.onContextCreate(fakeGl(i)));
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
const glReady = async (n: number) => {
  for (let k = 0; k < 100 && mockGl.length < n; k++) await wait(10);
  expect(mockGl.length).toBeGreaterThanOrEqual(n);
};

beforeEach(() => {
  mockGl.length = 0;
  mockRenderers.length = 0;
  mockFail = new Set();
  for (const k of Object.keys(mockGate)) delete mockGate[k];
});

it('모델을 읽어 그리기 반복을 돌고, 첫 프레임에 한 번만 준비를 알린다', async () => {
  const onReady = jest.fn();
  await render(<Avatar3D mood="talking" avatarId="base" onReady={onReady} />);
  await glReady(1);
  await createContext(0);
  await wait(120);
  expect(mockGl[0]!.endFrameEXP.mock.calls.length).toBeGreaterThan(1);
  expect(mockRenderers[0]!.render).toHaveBeenCalled();
  expect(onReady).toHaveBeenCalledTimes(1);
});

it('아바타를 바꾸면 새 모델을 읽는 동안에도 옛 그리기 반복을 바로 멈춘다', async () => {
  let open!: () => void;
  mockGate.jihoo = new Promise((r) => (open = r));
  const view = await render(<Avatar3D mood="idle" avatarId="base" />);
  await glReady(1);
  await createContext(0);
  await view.rerender(<Avatar3D mood="idle" avatarId="jihoo" />);
  expect(mockRenderers[0]!.dispose).toHaveBeenCalled();
  const frames = mockGl[0]!.endFrameEXP.mock.calls.length;
  await wait(100);
  expect(mockGl[0]!.endFrameEXP.mock.calls.length).toBe(frames);
  // 새 모델이 오면 새 GL 화면에서 다시 그린다
  open();
  const before = mockGl.length;
  await glReady(before + 1);
  await createContext(mockGl.length - 1);
  await wait(80);
  expect(mockGl.at(-1)!.endFrameEXP).toHaveBeenCalled();
});

it('바꾼 모델을 읽지 못하면 2D 얼굴로 대신하고 옛 반복은 멈춘 채로 둔다', async () => {
  mockFail.add('bora');
  const onReady = jest.fn();
  const view = await render(<Avatar3D mood="idle" avatarId="base" onReady={onReady} />);
  await glReady(1);
  await createContext(0);
  await view.rerender(<Avatar3D mood="idle" avatarId="bora" onReady={onReady} />);
  await wait(60);
  expect(screen.queryByTestId('gl')).toBeNull();
  const frames = mockGl[0]!.endFrameEXP.mock.calls.length;
  await wait(100);
  expect(mockGl[0]!.endFrameEXP.mock.calls.length).toBe(frames);
});

it('읽지 못한 모델 뒤에 다른 아바타로 바꾸면 2D에 머물지 않고 다시 3D로 그린다', async () => {
  mockFail.add('haneul');
  const view = await render(<Avatar3D mood="idle" avatarId="haneul" />);
  await wait(60);
  expect(screen.queryByTestId('gl')).toBeNull();
  await view.rerender(<Avatar3D mood="idle" avatarId="narae" />);
  await glReady(1);
  expect(screen.getByTestId('gl')).toBeTruthy();
});

it('실패한 모델을 다른 아바타 뒤에 다시 고르고 이번에 읽히면 3D로 돌아온다', async () => {
  mockFail.add('haneul');
  const view = await render(<Avatar3D mood="idle" avatarId="haneul" />);
  await wait(60);
  expect(screen.queryByTestId('gl')).toBeNull();
  await view.rerender(<Avatar3D mood="idle" avatarId="narae" />);
  await glReady(1);
  mockFail.delete('haneul');
  await view.rerender(<Avatar3D mood="idle" avatarId="haneul" />);
  await glReady(2);
  expect(screen.getByTestId('gl')).toBeTruthy();
});

it('화면을 떠나면 그리기 반복을 멈추고 GL 자원을 놓는다', async () => {
  const view = await render(<Avatar3D mood="idle" avatarId="base" />);
  await glReady(1);
  await createContext(0);
  await view.unmount();
  expect(mockRenderers[0]!.dispose).toHaveBeenCalled();
  const frames = mockGl[0]!.endFrameEXP.mock.calls.length;
  await wait(100);
  expect(mockGl[0]!.endFrameEXP.mock.calls.length).toBe(frames);
});

it('움직이는 부품(눈 · 입)은 따로 두고 나머지는 한 메시로 합친다', async () => {
  const { Scene } = jest.requireActual('three');
  const add = jest.spyOn(Scene.prototype, 'add');
  await render(<Avatar3D mood="idle" avatarId="base" />);
  await glReady(1);
  await createContext(0);
  const root = add.mock.calls[0]![0] as import('three').Object3D;
  const head = root.getObjectByName('head')!;
  const meshes: import('three').Mesh[] = [];
  head.traverse(
    (o) => (o as import('three').Mesh).isMesh && meshes.push(o as import('three').Mesh),
  );
  expect(meshes.map((m) => m.name).sort()).toEqual(
    expect.arrayContaining(['eyeL', 'eyeR', 'mouth']),
  );
  // 눈 둘 · 입 · 합친 얼굴 하나
  expect(meshes).toHaveLength(4);
  for (const m of meshes)
    expect((m.material as { isMeshMatcapMaterial?: boolean }).isMeshMatcapMaterial).toBe(true);
  add.mockRestore();
});

it('악세서리를 씌워도 머리에 합쳐 그리기 횟수는 그대로(눈 둘 · 입 · 얼굴 하나), 삼각형은 늘어난다', async () => {
  const { Scene } = jest.requireActual('three');
  const add = jest.spyOn(Scene.prototype, 'add');
  const faceTris = async (accessories?: string[]) => {
    add.mockClear();
    mockGl.length = 0;
    const view = await render(<Avatar3D mood="idle" avatarId="narae" accessories={accessories} />);
    await glReady(1);
    await createContext(0);
    const head = (add.mock.calls[0]![0] as import('three').Object3D).getObjectByName('head')!;
    const meshes: import('three').Mesh[] = [];
    head.traverse(
      (o) => (o as import('three').Mesh).isMesh && meshes.push(o as import('three').Mesh),
    );
    await view.unmount();
    const face = meshes.find((m) => !['eyeL', 'eyeR', 'mouth'].includes(m.name))!;
    return { count: meshes.length, tris: face.geometry.getAttribute('position').count / 3 };
  };
  const plain = await faceTris();
  const dressed = await faceTris(['beanie', 'roundGlasses', 'redScarf']);
  expect(dressed.count).toBe(4);
  expect(plain.count).toBe(4);
  expect(dressed.tris).toBeGreaterThan(plain.tris);
  add.mockRestore();
});

it('악세서리를 바꾸면 그 모습으로 GL 화면을 새로 그리고 옛 반복은 멈춘다', async () => {
  const view = await render(<Avatar3D mood="idle" avatarId="base" accessories={['beanie']} />);
  await glReady(1);
  await createContext(0);
  await view.rerender(<Avatar3D mood="idle" avatarId="base" accessories={['gradCap']} />);
  expect(mockRenderers[0]!.dispose).toHaveBeenCalled();
  await glReady(2);
  await createContext(mockGl.length - 1);
  const now = mockRenderers.at(-1)!;
  // 같은 모습을 새 배열로 넘기기만 하면(부모가 다시 그려도) GL 화면을 새로 만들지 않는다
  await view.rerender(<Avatar3D mood="talking" avatarId="base" accessories={['gradCap']} />);
  await wait(60);
  expect(now.dispose).not.toHaveBeenCalled();
  expect(now.render).toHaveBeenCalled();
});

it('lips를 넘기면 사인파 대신 그 입 모양으로 다가가고, 다문 입은 원래 크기', async () => {
  const { Scene } = jest.requireActual('three');
  const add = jest.spyOn(Scene.prototype, 'add');
  let lips = { open: 0, wide: 1 };
  await render(<Avatar3D mood="talking" avatarId="base" lips={() => lips} />);
  await glReady(1);
  await createContext(0);
  const root = add.mock.calls[0]![0] as import('three').Object3D;
  const mouth = root.getObjectByName('mouth')!;
  const [y0, x0] = [mouth.scale.y, mouth.scale.x];
  await wait(150);
  expect(mouth.scale.y).toBeCloseTo(y0, 5); // 말하는 표정이어도 소리가 없으면 다문다
  lips = { open: 1, wide: 1.1 };
  await wait(400);
  expect(mouth.scale.y / y0).toBeCloseTo(3.4, 1);
  expect(mouth.scale.x / x0).toBeCloseTo(1.1, 2);
  add.mockRestore();
});

describe('표정', () => {
  const { eyeOpen, FlatFace, MOUTH_WIDE } = jest.requireActual<
    typeof import('../features/tutor/avatar3d')
  >('../features/tutor/avatar3d');
  const h = (id: string) => screen.getByTestId(id).props.style.height as number;

  it('3D: 놀라면 두 눈을 크게, 윙크는 왼눈만 감고, 평소에는 깜빡임을 따른다', () => {
    expect(eyeOpen('surprised', 0, 1)).toBeGreaterThan(1);
    expect(eyeOpen('surprised', 1, 1)).toBeGreaterThan(1);
    expect(eyeOpen('wink', 0, 1)).toBeLessThan(0.2);
    expect(eyeOpen('wink', 1, 1)).toBe(1);
    expect(eyeOpen('idle', 0, 0.12)).toBe(0.12);
    expect(MOUTH_WIDE.surprised).toBeLessThan(1); // 동그랗게 오므린 입
    expect(MOUTH_WIDE.wink).toBeGreaterThan(1);
  });

  it('2D 얼굴도 같은 표정: 놀람은 큰 눈 · 동그란 입, 윙크는 왼눈만 감음', async () => {
    const view = await render(<FlatFace mood="surprised" size={100} />);
    expect(h('flat-eye-0')).toBeGreaterThan(12);
    expect(h('flat-mouth')).toBe(screen.getByTestId('flat-mouth').props.style.width);
    await view.rerender(<FlatFace mood="wink" size={100} />);
    expect(h('flat-eye-0')).toBeLessThan(h('flat-eye-1'));
  });
});

it('읽어 주는 이름에 쓰고 있는 치장을 넣는다', async () => {
  await render(<Avatar3D mood="idle" avatarId="bora" accessories={['beanie', 'roundGlasses']} />);
  expect(screen.getByLabelText('아바타 선생님, 털모자 · 동그란 안경 착용')).toBeTruthy();
  await render(<Avatar3D mood="idle" avatarId="bora" />);
  expect(screen.getByLabelText('아바타 선생님')).toBeTruthy();
});

it('모자를 쓰면 정수리가 높은 얼굴(나래)도 모자 꼭대기가 화면 안에 든다', () => {
  const THREE = jest.requireActual('three');
  const { attachAccessories } = jest.requireActual('../features/tutor/accessories');
  for (const framing of ['full', 'head'] as const)
    for (const hat of ['beanie', 'gradCap']) {
      // 모델의 머리(head)는 y -0.2에 있다(scripts/avatar-glb.mjs)
      const head = new THREE.Group();
      head.position.y = -0.2;
      attachAccessories(head, [hat], 'narae');
      head.updateMatrixWorld(true);
      const top = new THREE.Box3().setFromObject(head).max.y;
      const { pos, at } = cameraFor(framing, true);
      const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
      cam.position.set(...pos);
      cam.lookAt(0, at, 0);
      cam.updateMatrixWorld();
      const y = new THREE.Vector3(0, top, 0).project(cam).y;
      expect(y).toBeLessThan(0.95);
    }
  // 모자가 없으면 지금 구도 그대로
  expect(cameraFor('full', false)).toEqual({ pos: [0, 0.5, 3.5], at: 0.44 });
});
