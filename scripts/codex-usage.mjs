#!/usr/bin/env node
// 방금 끝난 Codex 실행의 남은 사용량을 뽑아 key=value 줄로 출력합니다 (scripts/codex-review.sh가 부름).
//
//   node scripts/codex-usage.mjs --since <시작 epoch ms> [--log <codex 로그> --failed 1] [--now <epoch ms>]
//
// - Codex는 세션 기록($CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl, 기본 ~/.codex)의 token_count
//   이벤트에 rate_limits(창별 사용률 · 창 길이(분) · 초기화 시각, 플랜)를 남깁니다. --since 이후에 바뀐
//   세션 기록 중 가장 최근 것의 마지막 rate_limits를 씁니다.
// - 한도에 걸리면 codex 로그에 "ERROR: You've hit your usage limit … try again at 3:01 PM."이 남습니다.
//   그때는 limit=1로 적고, 다시 가능한 시각(retry)을 그 문구(리뷰 컴퓨터 현지 시각)에서 읽습니다.
//   문구에서 못 읽으면 다 쓴(100%) 창의 초기화 시각을 씁니다.
//   codex 로그에는 프롬프트(리뷰할 PR 디프)도 찍히므로, 리뷰가 실패했을 때(--failed 1)만 로그를 보고
//   줄 맨 앞이 "ERROR:"인 줄만 봅니다(디프 줄은 + · - · 공백으로 시작). 그래야 PR 내용에 같은 문구가 있어도
//   한도로 잘못 보지 않습니다.
// - 사용률 · 초기화 시각 · 플랜 이름만 적습니다(계정 · 크레딧 잔액은 적지 않음. 결과 파일은 공개 저장소에 올라감).
// - 읽을 것이 없으면 아무것도 출력하지 않습니다. 오류로 리뷰를 멈추지 않도록 항상 0으로 끝납니다.
//
// 출력 (시각은 epoch 초, 모르는 값은 빈 값. p = primary 창, s = secondary 창):
//   at=… plan=… limit=0|1 retry=… p_used=… p_window=… p_reset=… s_used=… s_window=… s_reset=…
//
// 테스트: scripts/tests/codex-usage.bats

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// 실행이 끝날 때 세션 기록을 마저 쓰는 시간 · 파일 시스템 시각 오차
const SINCE_SLACK_MS = 5000;
// 리뷰는 60분 안에 끝나므로(codex-review.yml timeout) 최근 날짜 폴더 몇 개만 봄(자정 · 시간대 차이 대비)
const RECENT_DAY_DIRS = 3;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

// 숫자 이름의 하위 폴더를 내림차순으로
function numericDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
      .map((d) => d.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

// sessions/YYYY/MM/DD 중 최근 날짜 폴더
function recentDayDirs(sessions) {
  const days = [];
  for (const y of numericDirs(sessions)) {
    for (const m of numericDirs(path.join(sessions, y))) {
      for (const d of numericDirs(path.join(sessions, y, m))) {
        days.push(path.join(sessions, y, m, d));
        if (days.length >= RECENT_DAY_DIRS) return days;
      }
    }
  }
  return days;
}

// since 이후에 바뀐 세션 기록 중 가장 최근 것 (없으면 null)
function latestRollout(codexHome, sinceMs) {
  let best = null;
  for (const dir of recentDayDirs(path.join(codexHome, 'sessions'))) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^rollout-.*\.jsonl$/.test(name)) continue;
      const file = path.join(dir, name);
      let mtime;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (mtime + SINCE_SLACK_MS < sinceMs) continue;
      if (!best || mtime > best.mtime) best = { file, mtime };
    }
  }
  return best && best.file;
}

// 세션 기록의 마지막 rate_limits (없으면 null). 깨진 줄은 건너뜀
function lastRateLimits(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let last = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"rate_limits"')) continue;
    try {
      const p = JSON.parse(line).payload;
      if (p && p.type === 'token_count' && p.rate_limits) last = p.rate_limits;
    } catch {
      // 쓰는 중이던 마지막 줄 등
    }
  }
  return last;
}

// "3:01 PM" 또는 "Nov 5th, 2026 3:01 PM"(현지 시각) → epoch 초. 날짜가 없으면 오늘, 이미 지났으면 내일
function parseRetry(text, nowMs) {
  const m = /(?:([A-Z][a-z]{2})[a-z]* (\d{1,2})(?:st|nd|rd|th)?,? (\d{4}),? )?(\d{1,2}):(\d{2}) ?([AP]M)/.exec(text);
  if (!m) return null;
  let hour = Number(m[4]) % 12;
  if (m[6] === 'PM') hour += 12;
  const minute = Number(m[5]);
  if (m[1]) {
    const month = MONTHS.indexOf(m[1]);
    if (month < 0) return null;
    return Math.floor(new Date(Number(m[3]), month, Number(m[2]), hour, minute).getTime() / 1000);
  }
  const now = new Date(nowMs);
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
  if (at.getTime() < nowMs - 60000) at.setDate(at.getDate() + 1);
  return Math.floor(at.getTime() / 1000);
}

// codex 로그에서 한도 문구 → { retry } (한도 문구가 없으면 null)
function limitFromLog(file, nowMs) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const line = text.split(/\r?\n/).filter((l) => /^ERROR:.*usage limit/i.test(l)).pop();
  if (!line) return null;
  const again = /try again (?:at |on )?(.*)$/i.exec(line);
  return { retry: again ? parseRetry(again[1], nowMs) : null };
}

// 숫자면 반올림한 정수 문자열, 아니면 빈 값 (null · 빈 문자열은 숫자로 보지 않음)
function int(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n)) : '';
}

// 창 하나 → { used, window, reset } (초기화 시각은 resets_at(epoch 초), 옛 버전은 resets_in_seconds)
function windowOf(w, nowMs) {
  if (!w || typeof w !== 'object') return { used: '', window: '', reset: '' };
  let reset = int(w.resets_at);
  const inSec = int(w.resets_in_seconds);
  if (!reset && inSec) reset = String(Math.floor(nowMs / 1000) + Number(inSec));
  return { used: int(w.used_percent), window: int(w.window_minutes), reset };
}

function usage({ codexHome, sinceMs, logFile, failed, nowMs }) {
  const rollout = latestRollout(codexHome, sinceMs);
  const rl = rollout ? lastRateLimits(rollout) : null;
  // 리뷰가 성공했으면 한도에 걸린 것이 아니므로 로그를 보지 않음
  const hit = logFile && failed ? limitFromLog(logFile, nowMs) : null;
  if (!rl && !hit) return null;

  const p = windowOf(rl && rl.primary, nowMs);
  const s = windowOf(rl && rl.secondary, nowMs);
  const reached = Boolean(hit) || Boolean(rl && rl.rate_limit_reached_type);
  let retry = hit && hit.retry ? String(hit.retry) : '';
  if (reached && !retry) {
    // 다 쓴 창 중 가장 늦게 초기화되는 시각
    const full = [p, s].filter((w) => w.reset && Number(w.used) >= 100).map((w) => Number(w.reset));
    if (full.length) retry = String(Math.max(...full));
  }
  const plan = rl && typeof rl.plan_type === 'string' && /^[a-z0-9_]{1,32}$/.test(rl.plan_type) ? rl.plan_type : '';
  return {
    at: String(Math.floor(nowMs / 1000)),
    plan,
    limit: reached ? '1' : '0',
    retry,
    p_used: p.used,
    p_window: p.window,
    p_reset: p.reset,
    s_used: s.used,
    s_window: s.window,
    s_reset: s.reset,
  };
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const nowMs = args.now ? Number(args.now) : Date.now();
    const sinceMs = args.since ? Number(args.since) : nowMs - 3600000;
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const result = usage({ codexHome, sinceMs, logFile: args.log, failed: args.failed === '1', nowMs });
    if (result) {
      process.stdout.write(Object.entries(result).map(([k, v]) => `${k}=${v}\n`).join(''));
    }
  } catch {
    // 사용량을 못 읽어도 리뷰는 계속
  }
}

main();
