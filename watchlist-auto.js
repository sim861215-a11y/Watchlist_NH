/**
 * WATCHLIST PRO — 자동화 스크립트 v4
 * Claude 정책 생성 → Gemini 기사 수집 → Claude 리스크 분석
 * → 텔레그램 발송 + GitHub Pages HTML 리포트 생성
 *
 * ── GitHub Secrets 설정 ───────────────────────────────────────────────────────
 *  ANTHROPIC_API_KEY   : Anthropic API 키
 *  GEMINI_API_KEY      : Gemini API 키
 *  TELEGRAM_BOT_TOKEN  : 텔레그램 봇 토큰
 *  TELEGRAM_CHAT_ID    : 텔레그램 채팅/채널 ID
 *  PAGES_URL           : GitHub Pages URL  예) https://username.github.io/repo
 *                        (없으면 텔레그램 링크 생략)
 */

'use strict';

import fs     from 'fs';
import path   from 'path';
import crypto from 'crypto';

// ── 환경변수 ──────────────────────────────────────────────────────────────────
const CLAUDE_KEY  = process.env.ANTHROPIC_API_KEY;
const GEMINI_KEY  = process.env.GEMINI_API_KEY;
const TG_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID  = process.env.TELEGRAM_CHAT_ID;
const PAGES_URL      = (process.env.PAGES_URL || '').replace(/\/$/, '');
const REPORT_PASSWORD  = process.env.REPORT_PASSWORD  || '';
const ADMIN_PASSWORD   = process.env.ADMIN_PASSWORD   || '';  // 아카이브 초기화용 별도 비밀번호

// watchlist.txt에서 읽기 (한 줄에 기업명 하나, # 으로 주석 지원)
const COMPANIES = (() => {
  try {
    return fs.readFileSync(path.join(process.cwd(), 'watchlist.txt'), 'utf8')
      .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  } catch {
    console.error('❌ watchlist.txt 파일을 찾을 수 없습니다');
    process.exit(1);
  }
})();

// ── 아카이브 파일 ─────────────────────────────────────────────────────────────
const ARCHIVE_PATH = path.join(process.cwd(), 'watchlist-archive.json');

// ── 유틸 ──────────────────────────────────────────────────────────────────────
const sleep    = ms => new Promise(r => setTimeout(r, ms));
const todayStr = () => new Date().toISOString().split('T')[0];
const dateFrom = () => new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
const fmt      = s  => s ? `${s.slice(0,4)}.${s.slice(5,7)}.${s.slice(8,10)}` : '';

function log(msg) {
  const t = new Date().toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log(`[${t}] ${msg}`);
}

function loadArchive() {
  try {
    if (fs.existsSync(ARCHIVE_PATH))
      return JSON.parse(fs.readFileSync(ARCHIVE_PATH, 'utf8'));
  } catch {}
  return {};
}

function saveArchive(archive) {
  fs.writeFileSync(ARCHIVE_PATH, JSON.stringify(archive, null, 2), 'utf8');
}

// ── AES-256-GCM 암호화 ────────────────────────────────────────────────────────
// REPORT_PASSWORD Secret이 설정된 경우 아카이브 데이터를 암호화해서 HTML에 삽입.
// 소스 보기를 해도 암호화된 blob만 보이며, 비밀번호 없이는 복호화 불가.
function encryptArchive(jsonStr, password) {
  const salt      = crypto.randomBytes(16);
  const iv        = crypto.randomBytes(12);
  const key       = crypto.pbkdf2Sync(password, salt, 100_000, 32, 'sha256');
  const cipher    = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(jsonStr, 'utf8'), cipher.final()]);
  const tag       = cipher.getAuthTag();           // 16 bytes
  // 레이아웃: salt(16) | iv(12) | tag(16) | ciphertext
  return Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
}

function extractJSON(raw) {
  raw = raw.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();
  try { return JSON.parse(raw); } catch {}
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
    try {
      let s = m[0].trimEnd().replace(/,\s*$/, '');
      const o = (s.match(/\{/g)||[]).length, c = (s.match(/\}/g)||[]).length;
      s += '}}'.repeat(Math.max(0, o - c));
      return JSON.parse(s);
    } catch {}
  }
  return null;
}

// ── 중복 감지 ─────────────────────────────────────────────────────────────────
function checkDuplicate(company, result, archive) {
  if (!result.risk_factors?.length) return null;
  const today = todayStr();
  const titles = new Set(result.risk_factors.map(r => r.title));
  let bestDate = null, bestScore = 0;
  Object.entries(archive).forEach(([date, session]) => {
    if (date >= today) return;
    const prev = session[company];
    if (!prev?.risk_factors?.length) return;
    const prevTitles = prev.risk_factors.map(r => r.title);
    const matches = prevTitles.filter(t => titles.has(t)).length;
    const score = matches / Math.max(titles.size, prevTitles.length);
    if (score > bestScore) { bestScore = score; bestDate = date; }
  });
  return bestScore >= 0.66 ? { date: bestDate, score: bestScore } : null;
}

// ── 아카이브에서 기존 기사 제목 추출 ────────────────────────────────────────────
function getKnownArticleTitles(company, archive) {
  const titles = new Set();
  Object.values(archive).forEach(session => {
    const res = session[company];
    if (!res?.sources?.length) return;
    res.sources.forEach(s => { if (s.title) titles.add(s.title); });
  });
  return [...titles];
}

// ── STEP 1: Claude 검색 + 제목 스크리닝 ──────────────────────────────────────────
// ① Claude가 웹검색으로 기사 제목+스니펫 수집
// ② 아카이브 기존 기사와 비교해 새 리스크 후보만 선별
// ③ 선별된 기사를 분석용으로 반환
async function searchAndScreen(company, knownTitles) {
  const from = dateFrom(), to = todayStr();
  const knownBlock = knownTitles.length
    ? `\n\n[이미 수집된 기사 — 동일/유사 제목은 반드시 제외]\n${knownTitles.map((t,i)=>`${i+1}. ${t}`).join('\n')}`
    : '';

  const prompt = `당신은 기업 리스크 모니터링 전문 애널리스트입니다.

"${company}"의 최근 14일(${from} ~ ${to}) 리스크 관련 기사를 웹 검색으로 수집하세요.

[검색 전략 — 반드시 아래 순서로 진행]
1단계 — 제목 스크리닝: 아래 3개 영역에서 각 1~2개씩 검색 (총 5회 이내)
  · 재무: "${company} 적자" 또는 "${company} 손실" (기업 성격에 맞게 1개 선택)
  · 법률·규제: "${company} 과징금" 또는 "${company} 소송" (기업 성격에 맞게 1개 선택)
  · 경영·사고: "${company} 리스크" (기업 성격에 맞게 조정, 최근 뉴스 중심)
  · 추가 필요 시 1~2개 보완 검색 (총 5회 초과 금지)

2단계 — 스크리닝 기준으로 필터링:
  · ${from} ~ ${to} 범위 외 기사 제외
  · 아래 기존 수집 기사와 동일/유사한 내용 제외
  · 홍보·채용·신제품 출시 등 리스크 무관 기사 제외
  · 리스크성 있어 보이는 기사만 선별${knownBlock}

3단계 — 선별된 기사 상세 확인: 리스크성이 있는 기사는 내용을 더 읽고 요약

최종 출력 (JSON만, 코드블록 없이, 최대 5개):
{"articles":[{"title":"기사 제목","source":"언론사명","date":"YYYY-MM-DD","url":"URL","summary":"핵심 내용 1-2문장 (수치 포함)"}]}
기사 없으면: {"articles":[]}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 5000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!r.ok) {
    const e = await r.json().catch(()=>({}));
    throw new Error(e?.error?.message || `Claude search HTTP ${r.status}`);
  }

  const data  = await r.json();
  const raw   = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('').trim();
  if (!raw) return [];

  // "기사 없음" 텍스트 응답 처리
  const noArticleKeywords = ['없습니다','없어','찾을 수 없','수집할 수 없','no article','not found','검색 결과가 없','i am sorry','unable to fulfill','not supported','cannot fulfill','i cannot'];
  const parsedResult = extractJSON(raw);
  if (parsedResult) return parsedResult.articles || [];
  if (noArticleKeywords.some(k=>raw.toLowerCase().includes(k))) return [];
  throw new Error(`기사 수집 JSON 파싱 실패: ${raw.slice(0,120)}`);
}

// ── STEP 3: Claude → 리스크 분석 ─────────────────────────────────────────────
async function analyzeRisk(company, articles) {
  if (!articles.length)
    return { company, risk_factors:[], sources:[], overall_sentiment:'neutral', skip_reason:'no_new_news' };

  const articleText = articles.map((a,i)=>`[${i+1}] ${a.title}\n출처: ${a.source} | 날짜: ${a.date}\n요약: ${a.summary}`).join('\n\n');
  const prompt = `당신은 기업 리스크 전문 애널리스트입니다.
아래는 "${company}"에 관해 수집된 최근 14일 기사입니다.

${articleText}

severity 기준:
- high: 재무손실 확정 / 부채·차입금 급증 / 영업정지·과징금·형사기소 확정
- medium: 소송 진행중 / 규제조사 착수 / 실적둔화 가능성
- low: 평판리스크 / 임원교체 / 간접적 불확실성

JSON만 출력:
{"company":"${company}","risk_factors":[{"rank":1,"title":"리스크 제목","detail":"3-5문장","severity":"high|medium|low"}],"sources":[{"title":"제목","url":"URL","source":"언론사","date":"날짜"}],"overall_sentiment":"positive|neutral|negative","skip_reason":null}

risk_factors 최대 3개. JSON만 출력.`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e?.error?.message || `Claude HTTP ${r.status}`); }
  const data = await r.json();
  const raw = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('').trim();
  if (!raw) throw new Error('Claude 분석 응답이 비어있습니다');
  const parsed = extractJSON(raw);
  if (!parsed) throw new Error(`분석 JSON 파싱 실패: ${raw.slice(0,120)}`);

  if (parsed.sources?.length && articles.length) {
    parsed.sources = parsed.sources.map(src => {
      if (src.url) return src;
      const match = articles.find(a => a.title && src.title && a.title.includes(src.title.slice(0,10)));
      return { ...src, url: match?.url||'' };
    });
  }
  return parsed;
}

// ── 텔레그램 ──────────────────────────────────────────────────────────────────
const SENT_LABEL = { positive:'긍정 📈', neutral:'중립 ➖', negative:'리스크 ⚠️' };
const SVL = { high:'상', medium:'중', low:'하' };
const SVE = { high:'🔴', medium:'🟡', low:'🔵' };

function buildTgMsg(name, res, archive, pagesLink) {
  if (res.duplicate) {
    const prev = archive[res.duplicate.date]?.[name];
    if (prev && !prev.duplicate) return buildTgMsg(name, prev, archive, pagesLink);
  }
  const sentiment = SENT_LABEL[res.overall_sentiment] || '중립 ➖';
  let t = `<b>━━ ${name} ━━</b>\n종합 평가: <b>${sentiment}</b>\n`;
  if (res.error) { t += `❌ ${res.error}`; return t; }
  const risks = res.risk_factors || [];
  if (!risks.length) { t += '✅ 최근 14일 내 신규 리스크 없음'; return t; }
  // 리스크 헤드라인 — 제목 + 핵심 한 문장 요약
  t += '\n';
  risks.forEach(rf => {
    // detail에서 첫 문장만 추출 (마침표/개행 기준)
    const firstSentence = (rf.detail||'').split(/[.!?\n]/)[0].trim();
    const summary = firstSentence.length > 10 ? firstSentence + '.' : '';
    t += `${SVE[rf.severity]||'🟡'} <b>${rf.title}</b>  <i>심각도 ${SVL[rf.severity]||'-'}</i>\n`;
    if (summary) t += `  └ ${summary}\n`;
    t += '\n';
  });
  return t;
}

async function tgSendChunk(text) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: false }),
  });
  if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(`Telegram ${r.status}: ${e?.description||''}`); }
}

async function tgSend(text) {
  const MAX = 4000;
  if (text.length <= MAX) { await tgSendChunk(text); return; }
  // 4000자 초과 시 줄바꿈 기준으로 분할
  const lines = text.split('\n');
  let chunk = '';
  for (const line of lines) {
    if ((chunk + '\n' + line).length > MAX) {
      if (chunk) { await tgSendChunk(chunk.trim()); await sleep(300); }
      chunk = line;
    } else {
      chunk = chunk ? chunk + '\n' + line : line;
    }
  }
  if (chunk.trim()) await tgSendChunk(chunk.trim());
}

// ── HTML 리포트 생성 ──────────────────────────────────────────────────────────
function buildHtmlReport(archive, GITHUB_OWNER, GITHUB_REPO) {
  const archiveJson   = JSON.stringify(archive);
  const usePassword   = !!REPORT_PASSWORD;
  const dataBlock     = usePassword
    ? `const ENCRYPTED='${encryptArchive(archiveJson, REPORT_PASSWORD)}';`
    : `const ARCHIVE=${archiveJson};`;
  // 관리자 비밀번호는 HTML에서 직접 입력받아 PAT 검증 전에 사용
  // ADMIN_PASSWORD Secret 대신 초기화 시 PAT 입력으로 인증
  // 비밀번호 게이트 HTML 미리 계산 (템플릿 중첩 이슈 방지)
  const pwGateBlock = usePassword
    ? '<div id="pw-gate"><div id="pw-box">'
      + '<div class="logo-icon" style="margin:0 auto 16px;width:48px;height:48px;font-size:22px">W</div>'
      + '<div style="font-weight:900;color:var(--gold);font-size:18px;margin-bottom:6px">WATCHLIST PRO</div>'
      + '<div style="font-size:12px;color:var(--text3);margin-bottom:4px">비밀번호를 입력하세요</div>'
      + '<input id="pw-input" type="password" placeholder="········" autocomplete="current-password"/>'
      + '<button id="pw-btn" onclick="tryPw()">열람하기</button>'
      + '<div id="pw-err">⚠️ 비밀번호가 올바르지 않습니다</div>'
      + '</div></div>'
    : '';

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>WATCHLIST PRO</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;700&family=Noto+Sans+KR:wght@400;700;900&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#060a10;--bg2:#080c12;--bg3:#0d1117;--bg4:#090c10;
  --border:#1e293b;--border2:#334155;
  --text:#e2e8f0;--text2:#94a3b8;--text3:#475569;--text4:#334155;
  --gold:#f59e0b;--gold2:#d97706;
  --red:#f87171;--red-bg:#450a0a;
  --font:'Noto Sans KR',sans-serif;--mono:'IBM Plex Mono',monospace;
}
body{background:var(--bg);color:var(--text);font-family:var(--font);min-height:100vh}
::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:var(--bg3)}::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
.btn-sm{padding:8px 16px;font-size:12px;background:var(--bg3);border:1px solid var(--border);color:var(--text3);font-family:var(--font);font-weight:800;cursor:pointer;border-radius:10px;transition:.2s}
.btn-sm:hover{border-color:var(--border2);color:var(--text2)}
.lbl{font-size:10px;color:var(--text3);font-weight:800;letter-spacing:2px;margin-bottom:8px;display:block}
.badge{display:inline-flex;align-items:center;padding:2px 9px;border-radius:4px;font-size:10px;font-weight:800}
#hdr{background:var(--bg2);border-bottom:1px solid var(--border);padding:14px 20px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:100;gap:12px;flex-wrap:wrap}
.logo{display:flex;align-items:center;gap:13px}
.logo-icon{width:38px;height:38px;background:linear-gradient(135deg,var(--gold),var(--gold2));border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:900;color:#000;font-size:19px;flex-shrink:0;font-family:var(--mono)}
#tabs{background:var(--bg2);border-bottom:1px solid #0f172a;display:flex;padding:0 12px;overflow-x:auto}
.tab{background:none;border:none;border-bottom:2px solid transparent;padding:12px 18px;color:var(--text3);font-weight:800;font-size:13px;cursor:pointer;font-family:var(--font);transition:.25s;white-space:nowrap;flex-shrink:0}
.tab.active{color:var(--gold);border-bottom-color:var(--gold)}
#toast{position:fixed;top:70px;left:50%;transform:translateX(-50%);background:#1e293b;border:1px solid var(--border2);color:var(--text);padding:11px 22px;border-radius:10px;font-size:13px;font-weight:800;z-index:999;display:none;white-space:nowrap;box-shadow:0 8px 24px rgba(0,0,0,.5)}
#main{max-width:800px;margin:0 auto;padding:28px 16px}
.empty{text-align:center;padding:70px 0;color:var(--text4);border:1px dashed var(--border);border-radius:14px;font-size:14px;line-height:2}
.rcard{border-radius:14px;overflow:hidden;margin-bottom:20px;box-shadow:0 8px 24px rgba(0,0,0,.4)}
.rcard-hdr{display:flex;align-items:center;justify-content:space-between;padding:17px 22px;cursor:pointer;user-select:none}
.rcard-body{border-top:1px solid var(--border)}
.risk-item{background:var(--bg4);border-radius:12px;padding:17px 20px;border:1px solid var(--border);border-left-width:5px;margin-bottom:10px}
.risk-hdr{display:flex;align-items:flex-start;gap:10px;margin-bottom:10px}
.risk-num{flex-shrink:0;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;color:#000}
.risk-title{flex:1;font-size:15px;font-weight:800;color:#f1f5f9;line-height:1.4}
.risk-sev{flex-shrink:0;font-size:10px;font-weight:800;border-radius:4px;padding:2px 7px;border-width:1px;border-style:solid;opacity:.85}
.risk-detail{font-size:13px;color:var(--text2);line-height:1.85;padding-left:32px;white-space:pre-wrap}
.src-toggle{display:flex;align-items:center;justify-content:space-between;padding:13px 0;cursor:pointer;user-select:none;border-top:1px solid var(--border)}
.src-item{background:#0a0f18;border-radius:9px;padding:11px 15px;border:1px solid var(--border);display:flex;gap:11px;margin-bottom:7px}
.src-link{font-size:13px;font-weight:700;color:#60a5fa;text-decoration:none;line-height:1.5;display:block;word-break:break-word}
.src-link:hover{text-decoration:underline}
.src-nourl{font-size:13px;font-weight:700;color:var(--text3);line-height:1.5;display:block}
.src-meta{font-size:11px;color:var(--text4);margin-top:4px}
.arc-item{background:var(--bg3);border:1px solid var(--border);border-radius:13px;padding:18px 22px;margin-bottom:10px}
.date-bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:22px}
.date-chip{padding:7px 14px;border-radius:99px;font-size:12px;font-weight:800;cursor:pointer;border:1px solid var(--border);background:var(--bg3);color:var(--text3);font-family:var(--font);transition:.2s;white-space:nowrap}
.date-chip:hover{border-color:var(--border2);color:var(--text2)}
.date-chip.active{background:#1c1505;border-color:var(--gold2);color:var(--gold)}
@keyframes shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-8px)}40%,80%{transform:translateX(8px)}}
#pw-gate{position:fixed;inset:0;background:var(--bg);z-index:9999;display:none;align-items:center;justify-content:center;padding:24px}
#pw-box{background:var(--bg3);border:1px solid var(--border);border-radius:20px;padding:40px 36px;width:100%;max-width:400px;text-align:center}
#pw-input{background:var(--bg);border:1px solid var(--border2);border-radius:10px;padding:13px 18px;color:var(--text);font-size:14px;outline:none;width:100%;font-family:var(--font);margin:20px 0 10px;text-align:center;letter-spacing:2px}
#pw-input:focus{border-color:var(--gold)}
#pw-btn{background:var(--gold2);color:#000;border:none;border-radius:10px;padding:12px 32px;font-size:14px;font-weight:900;cursor:pointer;font-family:var(--font);width:100%;transition:.2s}
#pw-btn:hover{background:var(--gold)}
#pw-err{color:var(--red);font-size:12px;margin-top:10px;display:none}
@media(max-width:640px){
  #main{padding:16px 12px}
  .rcard-hdr{padding:14px 16px;flex-wrap:wrap;gap:8px}
  .risk-detail{padding-left:0;margin-top:8px}
  .risk-hdr{flex-wrap:wrap}
  .risk-sev{margin-left:auto}
  .date-chip{font-size:11px;padding:6px 11px}
  .arc-item{padding:14px 16px}
}
</style>
</head>
<body>
<div id="toast"></div>

${pwGateBlock}

<div id="hdr">
  <div class="logo">
    <div class="logo-icon">W</div>
    <div>
      <div style="font-weight:900;color:var(--gold);font-size:16px;font-family:var(--mono);letter-spacing:1px">WATCHLIST PRO</div>
      <div style="font-size:11px;color:var(--text3)">리스크 분석 리포트</div>
    </div>
  </div>
  <div id="hdr-meta" style="font-size:11px;color:var(--text3);text-align:right"></div>
</div>

<div id="tabs">
  <button class="tab active" onclick="switchTab('report')">📊 리포트</button>
  <button class="tab" onclick="switchTab('archive')">📁 아카이브</button>
</div>

<!-- 리포트 탭 -->
<div id="tab-report">
  <div id="main">
    <div class="date-bar" id="date-bar"></div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:8px">
      <div>
        <div id="rep-title" style="font-weight:900;font-size:20px;letter-spacing:-.02em"></div>
        <div id="rep-sub" style="font-size:12px;color:var(--text3);margin-top:3px"></div>
      </div>
      <div id="rep-chips" style="display:flex;gap:8px;flex-wrap:wrap"></div>
    </div>
    <div id="rep-content"></div>
  </div>
</div>

<!-- 아카이브 탭 -->
<div id="tab-archive" style="display:none">
  <div id="main">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:8px">
      <div>
        <div style="font-weight:900;font-size:20px">📁 아카이브</div>
        <div id="arc-total" style="font-size:12px;color:var(--text3);margin-top:3px"></div>
      </div>
      <button class="btn-sm" onclick="showResetModal()" style="color:#f87171;border-color:#450a0a;font-size:12px">🗑️ 아카이브 초기화</button>
    </div>
    <!-- 초기화 모달 -->
    <div id="reset-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9998;align-items:center;justify-content:center;padding:24px">
      <div style="background:#0d1117;border:1px solid #334155;border-radius:16px;padding:32px;width:100%;max-width:420px">
        <div style="font-weight:900;font-size:16px;margin-bottom:6px">🗑️ 아카이브 초기화</div>
        <div style="font-size:12px;color:var(--text3);margin-bottom:20px;line-height:1.7">GitHub의 <code style="background:#1e293b;padding:2px 6px;border-radius:4px">watchlist-archive.json</code> 파일이 비워집니다.<br>GitHub PAT (repo 권한)를 입력하세요.</div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:6px;font-weight:700">GitHub PAT <span style="color:#475569;font-weight:400">(Settings → Developer settings → PAT)</span></div>
        <input id="pat-input" type="password" placeholder="github_pat_..." style="background:#060a10;border:1px solid #334155;border-radius:8px;padding:11px 14px;color:var(--text);font-size:13px;outline:none;width:100%;font-family:var(--font);margin-bottom:12px"/>
        <div id="pat-err" style="color:#f87171;font-size:12px;margin-bottom:12px;display:none"></div>
        <div style="display:flex;gap:10px">
          <button class="btn-sm" onclick="hideResetModal()" style="flex:1">취소</button>
          <button class="btn-sm" onclick="doReset()" style="flex:1;color:#f87171;border-color:#450a0a" id="reset-btn">초기화 실행</button>
        </div>
      </div>
    </div>
    <div id="arc-list"></div>
  </div>
</div>

<script>
${dataBlock}
const GH_OWNER='${GITHUB_OWNER}',GH_REPO='${GITHUB_REPO}';

const SENT = {
  positive:{border:'#059669',label:'긍정 📈',bg:'#064e3b',text:'#6ee7b7'},
  neutral:{border:'#475569',label:'중립 ➖',bg:'#1e293b',text:'#94a3b8'},
  negative:{border:'#dc2626',label:'리스크 ⚠️',bg:'#450a0a',text:'#f87171'},
};
const SVC = {high:'#f43f5e',medium:'#eab308',low:'#3b82f6'};
const SVL = {high:'상',medium:'중',low:'하'};

let VIEW = null;
let ACTIVE_TAB = 'report';

function fmt(s){ return s?\`\${s.slice(0,4)}.\${s.slice(5,7)}.\${s.slice(8,10)}\`:''; }
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.style.display='block'; setTimeout(()=>t.style.display='none',2500); }

function toggleEl(id, chevId){
  const el=document.getElementById(id), ch=document.getElementById(chevId);
  const open=el.style.display!=='none';
  el.style.display=open?'none':'block';
  if(ch)ch.style.transform=open?'rotate(0deg)':'rotate(90deg)';
}

function switchTab(tab){
  ACTIVE_TAB=tab;
  document.getElementById('tab-report').style.display  = tab==='report'  ? '' : 'none';
  document.getElementById('tab-archive').style.display = tab==='archive' ? '' : 'none';
  document.querySelectorAll('.tab').forEach((el,i)=>el.classList.toggle('active', (i===0&&tab==='report')||(i===1&&tab==='archive')));
  if(tab==='archive') renderArchive();
}

function openArc(date){ VIEW=date; switchTab('report'); renderReport(); }

// ── 날짜 선택 바 ─────────────────────────────────────────────────────────────
function renderDateBar(){
  const dates = Object.keys(ARCHIVE).sort((a,b)=>b.localeCompare(a));
  const bar = document.getElementById('date-bar');
  if(!dates.length){ bar.innerHTML=''; return; }
  if(!VIEW) VIEW = dates[0];
  bar.innerHTML = dates.map(d=>\`
    <button class="date-chip \${d===VIEW?'active':''}" onclick="setDate('\${d}')">\${fmt(d)}</button>
  \`).join('');
}

function setDate(date){
  VIEW=date;
  document.querySelectorAll('.date-chip').forEach(el=>{
    el.classList.toggle('active', el.textContent.trim()===fmt(date));
  });
  renderReport();
}

// ── 리포트 렌더링 ─────────────────────────────────────────────────────────────
function renderReport(){
  renderDateBar();
  const dates = Object.keys(ARCHIVE).sort((a,b)=>b.localeCompare(a));
  const today = dates[0] || '';
  const data  = VIEW ? ARCHIVE[VIEW] : null;

  document.getElementById('rep-title').textContent = VIEW && VIEW !== today ? \`\${fmt(VIEW)} 리포트\` : '오늘의 리포트';
  document.getElementById('rep-sub').textContent   = '최근 14일 기준 리스크 분석';
  document.getElementById('hdr-meta').textContent  = \`업데이트 \${fmt(today)}\`;

  const content = document.getElementById('rep-content');
  const chips   = document.getElementById('rep-chips');

  if(!data){
    chips.innerHTML = '';
    content.innerHTML = '<div class="empty">분석 리포트가 없습니다<br><span style="font-size:12px">자동화 스크립트가 실행되면 여기에 표시됩니다</span></div>';
    return;
  }

  const names    = Object.keys(data);
  const riskCnt  = Object.values(data).filter(r=>r.overall_sentiment==='negative').length;
  const dupCnt   = Object.values(data).filter(r=>r.duplicate).length;
  chips.innerHTML = \`
    <span style="font-size:11px;color:var(--text3)">🏢 \${names.length}개 기업</span>
    \${riskCnt?'<span style="font-size:11px;color:#f87171">⚠️ 리스크 '+riskCnt+'건</span>':''}
    \${dupCnt?'<span style="font-size:11px;color:#a8a29e">♻️ 중복 '+dupCnt+'건</span>':''}
  \`;

  content.innerHTML = Object.entries(data).map(([name,res])=>buildCard(name,res)).join('');
}

function resolveRes(name, res){
  if(res.duplicate){
    const prev = ARCHIVE[res.duplicate.date]?.[name];
    if(prev && !prev.duplicate) return { res: prev, isDup: true, dupDate: res.duplicate.date, dupScore: res.duplicate.score };
  }
  return { res, isDup: false };
}

function buildCard(name, rawRes){
  const { res, isDup, dupDate, dupScore } = resolveRes(name, rawRes);
  const s    = SENT[rawRes.overall_sentiment] || SENT.neutral;
  const risks = res.risk_factors || [];
  const srcs  = res.sources || [];
  const cid   = 'c' + name.replace(/\\W/g,'_');
  const sid   = 's' + name.replace(/\\W/g,'_');

  // 리스크 바디
  let riskHtml = '';
  if(rawRes.error){
    riskHtml = \`<div style="padding:20px 22px;color:var(--red);font-size:13px">❌ \${esc(rawRes.error)}</div>\`;
  } else if(rawRes.duplicate && !res.risk_factors?.length){
    riskHtml = \`<div style="padding:20px 22px;color:var(--text3);font-size:13px">♻️ 이전 아카이브와 동일 (\${fmt(dupDate)})</div>\`;
  } else if(!risks.length){
    riskHtml = \`<div style="padding:44px 24px;text-align:center;color:var(--text3);font-size:14px">최근 14일 내 신규 리스크가 발견되지 않았습니다.</div>\`;
  } else {
    riskHtml = \`<div style="padding:18px 22px 4px">
      <div class="lbl">핵심 리스크 분석</div>
      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px">
        \${risks.map(rf=>{
          const c=SVC[rf.severity]||SVC.medium;
          return \`<div class="risk-item" style="border-left-color:\${c}">
            <div class="risk-hdr">
              <span class="risk-num" style="background:\${c}">\${rf.rank||''}</span>
              <span class="risk-title">\${esc(rf.title)}</span>
              <span class="risk-sev" style="color:\${c};border-color:\${c}">심각도 \${SVL[rf.severity]||'-'}</span>
            </div>
            <div class="risk-detail">\${esc(rf.detail)}</div>
          </div>\`;
        }).join('')}
      </div>
      \${srcs.length?\`
        <div class="src-toggle" onclick="toggleEl('\${sid}','cv\${sid}')">
          <div class="lbl" style="margin:0">검토 기사 (\${srcs.length}건)</div>
          <span id="cv\${sid}" style="font-size:11px;color:var(--text3);transition:.3s;display:inline-block">▶</span>
        </div>
        <div id="\${sid}" style="display:none;padding-bottom:16px">
          \${srcs.map((s,i)=>\`
            <div class="src-item">
              <span style="font-size:11px;color:var(--text4);font-weight:800;flex-shrink:0;min-width:18px;padding-top:2px">\${i+1}.</span>
              <div>
                \${s.url?\`<a href="\${esc(s.url)}" target="_blank" class="src-link">\${esc(s.title)}</a>\`:\`<span class="src-nourl">\${esc(s.title)}</span>\`}
                <div class="src-meta">\${esc(s.source||'')}\${s.date?' | '+s.date:''}</div>
              </div>
            </div>\`).join('')}
        </div>\`:''}
    </div>\`;
  }

  // 중복 뱃지 + 바디
  const dupBlock = rawRes.duplicate
    ? \`<div style="padding:22px;display:flex;flex-direction:column;gap:14px">
        <div style="display:flex;align-items:flex-start;gap:12px">
          <span style="font-size:22px;flex-shrink:0">♻️</span>
          <div>
            <div style="font-weight:800;font-size:14px;margin-bottom:5px;color:var(--text)">이전 분석과 동일한 리스크입니다</div>
            <div style="font-size:12px;color:var(--text3);line-height:1.7">
              <b style="color:var(--gold)">\${fmt(dupDate)}</b> 세션과
              <b style="color:var(--text2)">\${Math.round(dupScore*100)}%</b> 일치합니다.
            </div>
          </div>
        </div>
        <button class="btn-sm" onclick="openArc('\${dupDate}')" style="width:fit-content;color:var(--gold);border-color:var(--gold2);font-size:12px">
          📁 \${fmt(dupDate)} 아카이브 열람 →
        </button>
        \${riskHtml}
      </div>\`
    : riskHtml;

  return \`<div class="rcard" style="border:1px solid \${s.border};background:var(--bg3)">
    <div class="rcard-hdr" onclick="toggleEl('\${cid}','cv\${cid}')">
      <div style="font-weight:900;font-size:17px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        \${esc(name)}
        \${rawRes.error?'<span class="badge" style="background:var(--red-bg);color:var(--red)">실패</span>':''}
        \${rawRes.duplicate?'<span class="badge" style="background:#1c1917;color:#a8a29e;border:1px solid #44403c">♻️ 중복</span>':''}
        \${!rawRes.error&&!rawRes.duplicate&&rawRes.skip_reason==='no_new_news'?'<span class="badge" style="background:var(--bg);color:var(--text3)">신규 없음</span>':''}
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
        <span class="badge" style="background:\${s.bg};color:\${s.text};border:1px solid \${s.border}">\${s.label}</span>
        \${!rawRes.error&&!rawRes.duplicate&&risks.length?'<span style="font-size:11px;color:var(--text3)">리스크 '+risks.length+'건</span>':''}
        <span id="cv\${cid}" style="color:var(--text3);font-size:11px;display:inline-block;transform:rotate(90deg);transition:.3s">▶</span>
      </div>
    </div>
    <div class="rcard-body" id="\${cid}">\${dupBlock}</div>
  </div>\`;
}

// ── 아카이브 탭 렌더링 ────────────────────────────────────────────────────────
function renderArchive(){
  const dates = Object.keys(ARCHIVE).sort((a,b)=>b.localeCompare(a));
  document.getElementById('arc-total').textContent = \`총 \${dates.length}개 세션 저장됨\`;
  const list = document.getElementById('arc-list');
  if(!dates.length){
    list.innerHTML = '<div class="empty">저장된 리포트가 없습니다</div>';
    return;
  }
  list.innerHTML = dates.map(date=>{
    const s = ARCHIVE[date];
    const cl = Object.keys(s);
    const rc = cl.filter(n=>s[n].overall_sentiment==='negative').length;
    const dc = cl.filter(n=>s[n].duplicate).length;
    return \`<div class="arc-item">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap">
        <div>
          <div style="font-weight:900;font-size:15px;margin-bottom:6px">\${fmt(date)} 세션</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <span style="font-size:11px;color:var(--text3)">\${cl.length}개 기업</span>
            \${rc?'<span style="font-size:11px;color:var(--red)">리스크 감지 '+rc+'건</span>':''}
            \${dc?'<span style="font-size:11px;color:#a8a29e">♻️ 중복 '+dc+'건</span>':''}
            <span style="font-size:11px;color:var(--text4)">\${cl.join(' · ')}</span>
          </div>
        </div>
        <button class="btn-sm" onclick="openArc('\${date}')">열람 →</button>
      </div>
    </div>\`;
  }).join('');
}

// ── 아카이브 초기화 ──────────────────────────────────────────────────────────────
function showResetModal(){
  document.getElementById('pat-input').value = '';
  document.getElementById('pat-err').style.display='none';
  document.getElementById('reset-modal').style.display='flex';
  setTimeout(()=>document.getElementById('pat-input').focus(), 100);
}
function hideResetModal(){ document.getElementById('reset-modal').style.display='none'; }

async function doReset(){
  const inputPat = document.getElementById('pat-input').value.trim();
  const err = document.getElementById('pat-err');
  const btn = document.getElementById('reset-btn');
  if(!inputPat){ err.textContent='GitHub PAT를 입력해주세요.'; err.style.display='block'; return; }
  let pat = inputPat;
  if(!GH_OWNER||!GH_REPO){ err.textContent='저장소 정보를 확인할 수 없습니다.'; err.style.display='block'; return; }

  btn.textContent='초기화 중...'; btn.disabled=true;
  err.style.display='none';

  try {
    const getRes = await fetch(\`https://api.github.com/repos/\${GH_OWNER}/\${GH_REPO}/contents/watchlist-archive.json\`, {
      headers:{ 'Authorization': \`Bearer \${pat}\`, 'Accept': 'application/vnd.github+json' }
    });
    if(!getRes.ok){ localStorage.removeItem('gh_pat'); throw new Error(\`파일 조회 실패 (\${getRes.status}) — PAT를 다시 입력해주세요.\`); }
    const { sha } = await getRes.json();

    const putRes = await fetch(\`https://api.github.com/repos/\${GH_OWNER}/\${GH_REPO}/contents/watchlist-archive.json\`, {
      method: 'PUT',
      headers:{ 'Authorization': \`Bearer \${pat}\`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message:'\u{1F5D1}\uFE0F 아카이브 초기화', content: btoa('{}'), sha })
    });
    if(!putRes.ok){ localStorage.removeItem('gh_pat'); throw new Error(\`파일 업데이트 실패 (\${putRes.status})\`); }

    localStorage.setItem('gh_pat', pat);
    toast('\u2705 아카이브가 초기화되었습니다. 페이지를 새로고침합니다...');
    setTimeout(()=>location.reload(), 1800);
  } catch(e) {
    err.textContent = e.message;
    err.style.display = 'block';
    btn.textContent = '초기화 실행';
    btn.disabled = false;
  }
}

// ── 초기화 ─────────────────────────────────────────────────────────────────────
async function decryptAndInit(password) {
  try {
    const buf      = Uint8Array.from(atob(ENCRYPTED), c => c.charCodeAt(0));
    const salt     = buf.slice(0, 16);
    const iv       = buf.slice(16, 28);
    const tag      = buf.slice(28, 44);
    const cipher   = buf.slice(44);
    const ctWithTag = new Uint8Array(cipher.length + tag.length);
    ctWithTag.set(cipher); ctWithTag.set(tag, cipher.length);

    const km  = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name:'PBKDF2', salt, iterations:100000, hash:'SHA-256' },
      km, { name:'AES-GCM', length:256 }, false, ['decrypt']
    );
    const dec = await crypto.subtle.decrypt({ name:'AES-GCM', iv }, key, ctWithTag);
    window.ARCHIVE = JSON.parse(new TextDecoder().decode(dec));
    localStorage.setItem('wp_pass', password);          // 영구 저장 (탭 닫아도 유지)
    history.replaceState(null, '', location.pathname);  // URL에서 #hash 제거
    document.getElementById('pw-gate').style.display = 'none';
    renderReport();
  } catch {
    const err = document.getElementById('pw-err');
    err.style.display = 'block';
    const box = document.getElementById('pw-box');
    box.style.animation = 'shake .35s';
    setTimeout(() => box.style.animation = '', 400);
  }
}

${usePassword ? `
// 비밀번호 자동 시도 순서: URL hash → localStorage → 입력창
window.addEventListener('DOMContentLoaded', () => {
  const hash   = location.hash.slice(1);               // #비밀번호 → 비밀번호
  const stored = localStorage.getItem('wp_pass');
  if (hash)   { decryptAndInit(decodeURIComponent(hash)); return; }  // 텔레그램 링크
  if (stored) { decryptAndInit(stored); return; }                     // 재방문
  // 수동 입력 필요
  document.getElementById('pw-gate').style.display = 'flex';
  document.getElementById('pw-input').addEventListener('keydown', e => { if(e.key==='Enter') tryPw(); });
});
function tryPw() {
  const v = document.getElementById('pw-input').value.trim();
  if (!v) return;
  document.getElementById('pw-err').style.display = 'none';
  decryptAndInit(v);
}
` : `renderReport();`}
</script>
</body>
</html>`;
}

// ── 메인 ──────────────────────────────────────────────────────────────────────
async function main() {
  const missing = [
    !CLAUDE_KEY       && 'ANTHROPIC_API_KEY',
    !TG_TOKEN         && 'TELEGRAM_BOT_TOKEN',
    !TG_CHAT_ID       && 'TELEGRAM_CHAT_ID',
    !COMPANIES.length && 'watchlist.txt (비어있음)',
  ].filter(Boolean);
  if (missing.length) { console.error(`❌ 누락된 환경변수: ${missing.join(', ')}`); process.exit(1); }

  const today   = todayStr();
  const archive = loadArchive();
  const results = {};

  log(`🚀 분석 시작 — ${today} / ${COMPANIES.length}개 기업`);

  // 헤더 메시지
  log(`📨 텔레그램 Chat ID 앞3자리: ${String(TG_CHAT_ID).slice(0,3)} / 전체길이: ${String(TG_CHAT_ID).length}자리`);
  const pagesLink = PAGES_URL ? `${PAGES_URL}${REPORT_PASSWORD ? '/#'+encodeURIComponent(REPORT_PASSWORD) : ''}` : '';
  await tgSend(
    `📊 <b>WATCHLIST PRO 리스크 분석</b>\n` +
    `📅 ${fmt(today)} · 최근 14일\n` +
    `🏢 ${COMPANIES.length}개 기업\n` +
    `━━━━━━━━━━━━━━━`
  );

  // 기업별 3단계 파이프라인
  for (let i = 0; i < COMPANIES.length; i++) {
    const co = COMPANIES[i];
    log(`\n[${i+1}/${COMPANIES.length}] ${co}`);
    try {
      log(`  ① Claude: 기사 검색 + 스크리닝`);
      const knownTitles = getKnownArticleTitles(co, archive);
      const articles = await searchAndScreen(co, knownTitles);
      log(`     → ${articles.length}건 선별`);
      log(`  ② Claude: 리스크 분석`);
      const result = await analyzeRisk(co, articles);
      const dup = checkDuplicate(co, result, archive);
      if (dup) {
        log(`  ♻️  중복 — ${fmt(dup.date)} 세션과 ${Math.round(dup.score*100)}% 일치`);
        results[co] = { company: co, duplicate: dup, overall_sentiment: result.overall_sentiment, timestamp: Date.now() };
      } else {
        results[co] = { ...result, timestamp: Date.now() };
        log(`  ✅ 완료 — 감정: ${result.overall_sentiment} / 리스크: ${result.risk_factors?.length||0}건`);
      }
    } catch (e) {
      log(`  ❌ 오류: ${e.message}`);
      results[co] = { company: co, error: e.message, overall_sentiment: 'neutral', timestamp: Date.now() };
    }
    if (i < COMPANIES.length - 1) await sleep(65000);  // 65초 대기 (rate limit 리셋)
  }

  // 아카이브 저장
  archive[today] = results;
  // 아카이브는 초기화 전까지 전체 보관 (자동 삭제 없음)
  saveArchive(archive);
  log(`\n💾 아카이브 저장 완료`);

  // HTML 리포트 생성
  // GitHub owner/repo 추출 (초기화 API 호출용)
  let GITHUB_OWNER = '', GITHUB_REPO = '';
  if (PAGES_URL) {
    const m = PAGES_URL.replace('https://', '').match(/^([^.]+)\.github\.io\/(.+)/);
    if (m) { GITHUB_OWNER = m[1]; GITHUB_REPO = m[2].split('/')[0]; }
  }
  const html = buildHtmlReport(archive, GITHUB_OWNER, GITHUB_REPO);
  const reportPath = path.join(process.cwd(), 'docs', 'index.html');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, html, 'utf8');
  log(`📄 HTML 리포트 생성 완료`);

  // 텔레그램: 기업별 발송
  for (const [name, res] of Object.entries(results)) {
    await tgSend(buildTgMsg(name, res, archive, pagesLink));
    await sleep(500);
  }

  // 푸터 메시지 (Pages URL 포함)
  const riskCount = Object.values(results).filter(r => r.overall_sentiment === 'negative').length;
  const dupCount  = Object.values(results).filter(r => r.duplicate).length;
  const footer = [
    `━━━━━━━━━━━━━━━`,
    `✅ 분석 완료`,
    riskCount ? `⚠️ 리스크 감지: ${riskCount}개 기업` : `✅ 전 기업 이상 없음`,
    dupCount  ? `♻️ 이전 아카이브 동일: ${dupCount}개 기업` : '',
    pagesLink
      ? `\n📋 리스크 상세 내용 및 출처 기사는 아래에서 확인하세요\n<a href="${pagesLink}">${pagesLink}</a>`
      : '',
  ].filter(Boolean).join('\n');
  await tgSend(footer);

  log(`\n🎉 완료 — 리스크 ${riskCount}건 / 중복 ${dupCount}건`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
