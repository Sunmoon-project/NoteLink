#!/usr/bin/env node
// 리뷰 컴퓨터 Codex 계정의 지금 남은 사용량(5시간 · 주간)을 디스코드 메시지 하나에 계속 고쳐 보여 줍니다.
// (.github/workflows/codex-usage-live.yml이 리뷰 컴퓨터 러너에서 부름)
//
//   node scripts/codex-usage-live.mjs [--now <epoch ms>] [--dry-run]
//
// - `codex app-server`에 account/rateLimits/read를 보내 읽습니다. 토큰을 쓰지 않고, 리뷰가 돌지 않아도 읽힙니다.
//   (리뷰가 끝날 때 세션 기록에서 뽑는 scripts/codex-usage.mjs와 달리 지금 값을 바로 받음)
// - 디스코드: 처음이면 웹후크로 새 메시지를 올리고(?wait=true로 id를 받음), 그다음부터는 그 메시지를 고칩니다.
//   메시지 id와 마지막으로 읽은 값은 리뷰 컴퓨터의 상태 파일에 둡니다. 메시지가 지워졌으면(404) 새로 올립니다.
// - 기준 값은 scripts/codex-usage-lib.sh와 같습니다: 🟢 남은 양 20% 이상 · 🟡 20% 미만 · ⏸️ 10% 이하이거나 한도.
//   표시만 합니다. 리뷰를 멈출지는 codex-review.sh가 마지막 리뷰의 기록으로 따로 정하므로 서로 다를 수 있습니다.
// - 읽지 못하면 마지막으로 읽은 값을 그대로 두고 ⚠️ 확인 실패와 시각을 적습니다(경고만 남기고 0으로 끝남).
//   꼬리말에는 마지막으로 읽은 시각을 두고, 마지막 값이 🟡 · ⏸️였으면 그 색을 유지합니다.
//   디스코드에 올리지 못하면 1로 끝납니다(Actions에 실패로 보임).
// - 사용률 · 창 길이 · 초기화 시각 · 플랜 이름만 다룹니다. 계정 · 크레딧은 로그 · 메시지 · 상태 파일에 넣지 않습니다.
//   app-server · 서버의 오류 원문에도 계정 정보가 섞일 수 있어, 오류는 정해진 문구와 코드만 적습니다.
//
// 환경 변수
//   DISCORD_WEBHOOK            디스코드 웹후크 주소 (--dry-run이 아니면 필수)
//   CODEX_USAGE_LIVE_STATE     상태 파일 (기본 ~/.notelink/codex-usage-live.json)
//   CODEX_BIN                  codex 실행 명령 (기본 codex, 테스트에서 가짜로 바꿈)
//   USAGE_WARN_LEFT · USAGE_STOP_LEFT   경고 · 멈춤 기준(남은 %, 기본 20 · 10)
//   USAGE_LIVE_EVERY           메시지에 적는 갱신 간격(분, 기본 10)
//   CODEX_READ_TIMEOUT_MS      app-server 응답을 기다리는 시간 (기본 30000)
//
// 테스트: scripts/tests/codex-usage-live.bats

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WARN_LEFT = Number(process.env.USAGE_WARN_LEFT || 20);
const STOP_LEFT = Number(process.env.USAGE_STOP_LEFT || 10);
const EVERY_MIN = Number(process.env.USAGE_LIVE_EVERY || 10);
const READ_TIMEOUT_MS = Number(process.env.CODEX_READ_TIMEOUT_MS || 30000);
const BAR_CELLS = 10;

// 디스코드 embed 색 (scripts/runner-status.sh와 같음)
const COLOR = { ok: 3187820, warn: 16098596, stop: 15761187, error: 9145752 };
const MARK = { ok: '🟢', warn: '🟡', stop: '⏸️' };

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'dry-run') out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

// epoch 초 → "11/04 06:32" (서울)
function kst(sec) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(sec * 1000));
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${v.month}/${v.day} ${v.hour}:${v.minute}`;
}

// 창 길이(분) → "5시간" · "주간" · "3일" … (scripts/runner-status.sh의 window_name과 같음)
function windowName(mins) {
  if (mins === 10080) return '주간';
  if (mins >= 1440 && mins % 1440 === 0) return `${mins / 1440}일`;
  if (mins >= 60 && mins % 60 === 0) return `${mins / 60}시간`;
  return `${mins}분`;
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 셸로 띄운 자식을 그 아래 프로세스까지 끝냄 (Windows의 kill은 cmd만 끝내고 codex가 남음)
function killTree(child) {
  try {
    if (process.platform === 'win32') {
      // 끝날 때까지 기다림(이 프로세스가 먼저 끝나면 taskkill이 돌지 못함)
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      // 셸(sh -c)과 그 아래 codex를 함께 끝내도록 프로세스 그룹째 (detached로 띄워 그룹을 따로 둠)
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  } catch { /* 이미 끝남 */ }
}

// JSON-RPC 오류 → "코드 N" (원문 message는 공개 로그 · 메시지에 넣지 않음)
function errCode(e) {
  return e && Number.isInteger(e.code) ? `코드 ${e.code}` : '알 수 없음';
}

// `codex app-server`에 account/rateLimits/read를 보내 rateLimits를 받음 (실패하면 Error)
function readRateLimits() {
  return new Promise((resolve, reject) => {
    // Windows의 codex는 npm이 만든 codex.cmd라 셸로 띄움. 명령은 고정 문자열(외부 입력 없음)
    const child = spawn(`${process.env.CODEX_BIN || 'codex'} app-server`, {
      shell: true, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      detached: process.platform !== 'win32', // Linux · macOS: 프로세스 그룹째 끝낼 수 있게
    });
    let buf = '';
    let done = false;
    let exited = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // stdin을 닫으면 app-server가 스스로 끝남. 실패(시간 초과 등)했거나 2초 안에 끝나지 않으면
      // 프로세스 트리째 끝냄(남겨 두면 리뷰 컴퓨터에 codex가 쌓이고, Windows에서는 부모의 출력도 붙잡음)
      try { child.stdin.end(); } catch { /* 이미 닫힘 */ }
      child.stdout.destroy();
      if (err && !exited) killTree(child);
      else if (!exited) {
        const killer = setTimeout(() => killTree(child), 2000);
        child.once('exit', () => clearTimeout(killer));
      }
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('응답 없음(시간 초과)')), READ_TIMEOUT_MS);
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    child.on('error', (e) => finish(new Error(`codex를 실행하지 못함(${typeof e.code === 'string' ? e.code : '알 수 없음'})`)));
    child.on('exit', () => { exited = true; });
    // close는 stdout을 다 읽은 뒤에 옴(exit는 남은 출력보다 먼저 올 수 있음)
    child.on('close', (code) => finish(new Error(`codex app-server가 끝남(코드 ${code})`)));
    child.stdin.on('error', () => { /* 끝난 뒤 쓰기 */ });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          if (m.error) return finish(new Error(`initialize 실패(${errCode(m.error)})`));
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read', params: null });
        } else if (m.id === 2) {
          if (m.error || !m.result || !m.result.rateLimits) {
            return finish(new Error(`사용량 읽기 실패(${m.error ? errCode(m.error) : '결과 없음'})`));
          }
          return finish(null, m.result.rateLimits);
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'notelink-usage-live', version: '1.0.0' } } });
  });
}

// rateLimits → { at, plan, reached, windows: [{ mins, used, reset }] } (계정 · 크레딧은 버림)
function normalize(rl, nowSec) {
  const windows = [];
  for (const w of [rl.primary, rl.secondary]) {
    if (!w || typeof w !== 'object') continue;
    const mins = num(w.windowDurationMins);
    const used = num(w.usedPercent);
    if (mins === null || used === null) continue;
    windows.push({ mins, used: Math.round(used), reset: num(w.resetsAt) });
  }
  windows.sort((a, b) => a.mins - b.mins);
  const plan = typeof rl.planType === 'string' && /^[a-z0-9_]{1,32}$/.test(rl.planType) ? rl.planType : '';
  return { at: nowSec, plan, reached: Boolean(rl.rateLimitReachedType), windows };
}

// 창 하나 → { left, level, reset, passed }. 초기화 시각이 지난 창은 다 남은 것(100%)으로 봄
function windowState(w, nowSec) {
  const passed = w.reset !== null && w.reset <= nowSec;
  const left = passed ? 100 : Math.max(0, Math.min(100, 100 - w.used));
  const level = left <= STOP_LEFT ? 'stop' : left < WARN_LEFT ? 'warn' : 'ok';
  return { left, level, passed };
}

function bar(left) {
  const full = Math.round((left / 100) * BAR_CELLS);
  return '█'.repeat(full) + '░'.repeat(BAR_CELLS - full);
}

// 상태 파일의 값(snap)과 이번 결과로 embed 하나를 만듦. failure = 이번에 읽지 못한 이유(성공이면 null)
function compose(snap, nowSec, failure) {
  const lines = [];
  let worst = 'ok';
  const rank = { ok: 0, warn: 1, stop: 2 };
  if (failure) {
    lines.push(`⚠️ ${kst(nowSec)} 확인 실패: ${failure}`);
    lines.push(snap ? `아래는 ${kst(snap.at)}에 읽은 값입니다.` : '아직 읽은 값이 없습니다.');
    if (snap) lines.push('');
  }
  if (snap) {
    if (!snap.windows.length) lines.push('창 정보가 없습니다.');
    for (const w of snap.windows) {
      const s = windowState(w, nowSec);
      if (rank[s.level] > rank[worst]) worst = s.level;
      const when = w.reset === null ? '' : s.passed ? ` · ${kst(w.reset)} 초기화됨` : ` · ${kst(w.reset)} 초기화`;
      lines.push(`${MARK[s.level]} **${windowName(w.mins)}** ${s.left}% 남음 \`${bar(s.left)}\`${when}`);
    }
    // 한도 표시는 다 쓴(100%) 창이 아직 초기화되지 않았을 때만. 다 쓴 창 정보가 없으면(한도 이유를 모름)
    // 초기화된 창이 하나라도 있을 때 옛 값으로 보고 무시
    const exhausted = snap.windows.filter((w) => w.used >= 100 && !windowState(w, nowSec).passed);
    const anyPassed = snap.windows.some((w) => windowState(w, nowSec).passed);
    const stillReached = snap.reached && (exhausted.length > 0 || !anyPassed);
    // 리뷰를 멈출지는 codex-review.sh가 마지막 리뷰 기록으로 따로 정하므로, 여기서는 기준에 걸렸다고만 적음
    if (stillReached) {
      worst = 'stop';
      lines.push('', '⏸️ 사용량 한도에 걸려 있습니다(리뷰 멈춤 기준).');
    } else if (worst === 'stop') {
      lines.push('', `⏸️ 남은 양이 ${STOP_LEFT}% 이하입니다(리뷰 멈춤 기준).`);
    } else if (worst === 'warn') {
      lines.push('', `🟡 남은 양이 ${WARN_LEFT}% 미만입니다.`);
    }
  }
  // 읽지 못했으면 꼬리말에 지금 시각 대신 마지막으로 읽은 시각을 둠(오래된 값이 방금 읽은 값처럼 보이지 않게)
  const when = !failure ? `${kst(snap.at)} 확인` : snap ? `${kst(snap.at)}에 마지막으로 읽음` : '읽은 값 없음';
  lines.push('', `${snap && snap.plan ? `플랜 ${snap.plan} · ` : ''}${when}`
    + ` (${EVERY_MIN}분마다 · Codex 리뷰가 끝날 때마다 고침)`);
  return {
    title: '📊 Codex 남은 사용량 (리뷰 컴퓨터)',
    description: lines.join('\n'),
    // 읽지 못했어도 마지막 값이 🟡 · ⏸️였으면 그 색을 유지(회색으로 바꾸면 멈춤 기준에 걸린 것이 가려짐)
    color: failure && worst === 'ok' ? COLOR.error : COLOR[worst],
  };
}

function loadState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`);
  fs.renameSync(tmp, file);
}

function webhookUrl(base, suffix, query) {
  const u = new URL(base);
  u.pathname = u.pathname.replace(/\/$/, '') + suffix;
  for (const [k, v] of Object.entries(query || {})) u.searchParams.set(k, v);
  return u.toString();
}

// 메시지를 고치거나(있으면) 새로 올림 → 메시지 id. 실패하면 Error
async function upsertMessage(webhook, messageId, embed) {
  const body = JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } });
  const headers = { 'Content-Type': 'application/json' };
  if (messageId) {
    const res = await fetch(webhookUrl(webhook, `/messages/${encodeURIComponent(messageId)}`), {
      method: 'PATCH', headers, body,
    });
    if (res.ok) return messageId;
    // 메시지가 지워졌으면 새로 올림. 다른 오류는 새 메시지를 만들지 않음(메시지가 여러 개 생기지 않게)
    if (res.status !== 404) throw new Error(`메시지 고치기 실패(HTTP ${res.status})`);
  }
  const res = await fetch(webhookUrl(webhook, '', { wait: 'true' }), { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`메시지 올리기 실패(HTTP ${res.status})`);
  const json = await res.json();
  if (!json || typeof json.id !== 'string') throw new Error('올린 메시지의 id가 없음');
  return json.id;
}

function summary(snap, nowSec) {
  return snap.windows.map((w) => `${windowName(w.mins)} ${windowState(w, nowSec).left}% 남음`).join(' · ')
    + (snap.plan ? ` · 플랜 ${snap.plan}` : '');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const nowMs = args.now ? Number(args.now) : Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const stateFile = process.env.CODEX_USAGE_LIVE_STATE || path.join(os.homedir(), '.notelink', 'codex-usage-live.json');
  const webhook = process.env.DISCORD_WEBHOOK || '';
  if (!args['dry-run'] && !webhook) {
    console.error('::error::DISCORD_WEBHOOK이 없습니다.');
    return 1;
  }

  const state = loadState(stateFile);
  let snap = state.last && Array.isArray(state.last.windows) ? state.last : null;
  let failure = null;
  try {
    snap = normalize(await readRateLimits(), nowSec);
    console.log(`Codex 사용량: ${summary(snap, nowSec)}`);
  } catch (e) {
    failure = String(e.message || e).slice(0, 200);
    console.log(`::warning::Codex 사용량을 읽지 못했습니다: ${failure}`);
  }

  const embed = compose(snap, nowSec, failure);
  if (args['dry-run']) {
    console.log(JSON.stringify(embed));
    return 0;
  }
  let messageId;
  try {
    messageId = await upsertMessage(webhook, state.messageId, embed);
  } catch (e) {
    console.error(`::error::디스코드에 올리지 못했습니다: ${e.message}`);
    return 1;
  }
  try {
    saveState(stateFile, { messageId, last: snap });
  } catch (e) {
    // id를 못 두면 다음 실행이 메시지를 또 올리므로 실패로 알림
    console.error(`::error::상태 파일(${stateFile})을 쓰지 못했습니다. 다음 실행에서 메시지가 새로 올라갑니다: ${e.message}`);
    return 1;
  }
  console.log(messageId === state.messageId ? '디스코드 메시지를 고쳤습니다.' : '디스코드에 새 메시지를 올렸습니다.');
  return 0;
}

main().then((code) => { process.exitCode = code; }, (e) => {
  console.error(`::error::${e && e.message ? e.message : e}`);
  process.exitCode = 1;
});
