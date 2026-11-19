// 상점 썸네일(assets/items/<id>.png)을 앱의 3D와 같은 코드(bake.ts · accessories.ts)로 굽는다.
// 아바타 모델(avatar-glb.mjs)이나 치장 모양을 바꾸면 다시 실행:
//   node apps/mobile/scripts/item-thumbs/serve.mjs  → 출력된 주소를 브라우저로 열면 모두 저장하고 끝난다
// 목록에 GLView를 여러 개 띄우면 iOS GL 컨텍스트 한도 · 성능 문제가 있어 미리 그린 그림을 쓴다
import { Buffer } from 'node:buffer';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// vite는 앱 의존성이 아니라 저장소 루트의 개발 도구(vitest가 설치)라 실행할 때만 불러온다
const { createServer } = await import('vite');

const here = dirname(fileURLToPath(import.meta.url));
const mobile = join(here, '../..');
const out = join(mobile, 'assets/items');

const server = await createServer({
  root: here,
  configFile: false,
  logLevel: 'warn',
  server: { port: 5199, fs: { allow: [mobile, join(mobile, '../..')] } },
  plugins: [
    {
      name: 'save-thumbs',
      configureServer(s) {
        s.middlewares.use('/save', (req, res) => {
          const name = new URL(req.url, 'http://x').searchParams.get('name') ?? '';
          if (!/^[a-zA-Z]+$/.test(name)) return res.writeHead(400).end();
          const chunks = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => {
            writeFileSync(join(out, `${name}.png`), Buffer.concat(chunks));
            console.log('saved', name);
            res.end('ok');
          });
        });
        s.middlewares.use('/done', (_req, res) => {
          res.end('ok');
          setTimeout(() => process.exit(0), 100);
        });
      },
    },
  ],
});
await server.listen();
console.log('open http://localhost:5199/');
