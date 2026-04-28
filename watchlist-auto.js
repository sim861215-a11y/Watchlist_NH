/**
 * WATCHLIST PRO — 자동화 스크립트 (v15 기준)
 * Claude 정책 생성 → Gemini 기사 수집 → Claude 리스크 분석 → 텔레그램 발송
 *
 * ── GitHub Secrets 설정 필요 ──────────────────────────────────────────────────
 *  ANTHROPIC_API_KEY   : Anthropic API 키 (sk-ant-...)
 *  GEMINI_API_KEY      : Gemini API 키 (AIza...)
 *  TELEGRAM_BOT_TOKEN  : 텔레그램 봇 토큰
 *  TELEGRAM_CHAT_ID    : 텔레그램 채팅/채널 ID
 *  (기업 목록은 watchlist.txt 파일에서 관리 — Secret 불필요)
 */

'use strict';

import fs   from 'fs';
import path from 'path';

// ── 환경변수 ──────────────────────────────────────────────────────────────────
const CLAUDE_KEY  = process.env.ANTHROPIC_API_KEY;
const GEMINI_KEY  = process.env.GEMINI_API_KEY;
const TG_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID  = process.env.TELEGRAM_CHAT_ID;
// watchlist.txt에서 읽기 (한 줄에 기업명 하나, # 으로 주석 지원)
const COMPANIES = (() => {
  try {
    return fs.readFileSync(path.join(process.cwd(), 'watchlist.txt'), 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
  } catch {
    console.error('❌ watchlist.txt 파일을 찾을 수 없습니다');
    process.exit(1);
  }
})();

// ── 아카이브 파일 경로 ────────────────────────────────────────────────────────
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

function extractJSON(raw) {
  raw = raw.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();
  try { return JSON.parse(raw); } catch {}
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
    try {
      let s = m[0].trimEnd().replace(/,\s*$/, '');
      const o = (s.match(/\{/g) || []).length;
      const c = (s.match(/\}/g) || []).length;
      s += '}}'.repeat(Math.max(0, o - c));
      return JSON.parse(s);
    } catch {}
  }
  return null;
}

// ── 중복 감지 (v15와 동일 로직, 66% 이상 일치 시 중복 판정) ─────────────────
function checkDuplicate(company, result, archive) {
  if (!result.risk_factors?.length) return null;
  const today  = todayStr();
  const cutoff = dateFrom();
  const titles = new Set(result.risk_factors.map(r => r.title));
  let bestDate = null, bestScore = 0;

  Object.entries(archive).forEach(([date, session]) => {
    if (date >= today || date < cutoff) return;
    const prev = session[company];
    if (!prev?.risk_factors?.length) return;
    const prevTitles = prev.risk_factors.map(r => r.title);
    const matches    = prevTitles.filter(t => titles.has(t)).length;
    const score      = matches / Math.max(titles.size, prevTitles.length);
    if (score > bestScore) { bestScore = score; bestDate = date; }
  });

  return bestScore >= 0.66 ? { date: bestDate, score: bestScore } : null;
}

// ── STEP 1: Claude → 검색 정책 생성 ──────────────────────────────────────────
async function buildSearchPolicy(company) {
  const from = dateFrom();
  const to   = todayStr();

  const prompt = `당신은 기업 리스크 리서치 디렉터입니다.
아래 기업에 대해 리스크 중심 뉴스를 수집하도록 검색 에이전트(Gemini)에게 전달할 구조화된 검색 정책을 JSON으로 만드세요.

기업명: ${company}
수집 기간: ${from} ~ ${to}

출력 JSON 형식 (이 형식 그대로만 출력):
{
  "company": "${company}",
  "date_from": "${from}",
  "date_to": "${to}",
  "search_queries": ["검색어1", "검색어2", "검색어3"],
  "priority_topics": ["우선수집 주제1", "우선수집 주제2"],
  "exclude_topics": ["제외할 주제1"],
  "article_limit": 5,
  "instructions": "Gemini에게 전달할 수집 지침 (한국어, 3-4문장)"
}

search_queries: 리스크 탐지에 최적화된 검색어 3개 (재무/소송/규제/사고 등 위험 신호 탐지 목적)
priority_topics: 재무손실, 부채급증, 과징금, 영업정지, 형사기소, 계약해지, 실적쇼크 등 실질적 리스크 주제
exclude_topics: 단순 IR 홍보, 채용공고, 제품출시 등 리스크와 무관한 주제
instructions: Gemini가 기사를 선별할 때 따라야 할 구체적 기준 명시

JSON만 출력하세요.`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         CLAUDE_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e?.error?.message || `Claude HTTP ${r.status}`); }
  const data   = await r.json();
  const raw    = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('').trim();
  const parsed = extractJSON(raw);
  if (!parsed) throw new Error('검색 정책 JSON 파싱 실패');
  return parsed;
}

// ── STEP 2: Gemini → 기사 수집 ───────────────────────────────────────────────
async function collectArticles(policy) {
  const prompt = `당신은 뉴스 수집 에이전트입니다. 아래 검색 정책을 정확히 따라 기사를 수집하고 JSON으로 반환하세요.

=== 검색 정책 ===
기업명: ${policy.company}
수집 기간: ${policy.date_from} ~ ${policy.date_to}
검색어: ${policy.search_queries.join(', ')}
우선 수집 주제: ${policy.priority_topics.join(', ')}
제외 주제: ${policy.exclude_topics.join(', ')}
최대 기사 수: ${policy.article_limit}개
수집 지침: ${policy.instructions}
=================

위 정책의 검색어로 Google 검색을 실행하고 기사를 선별하세요.

출력 형식 (코드블록 없이 JSON만):
{"articles":[{"title":"기사 제목","source":"언론사명","date":"YYYY-MM-DD","summary":"핵심 내용 1-2문장"}]}

규칙: URL 포함 금지 / 수집 기간 외 제외 / 기사 없으면 {"articles":[]}`;

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools:    [{ google_search: {} }],
        generationConfig: { temperature: 1.0, maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
      }),
    }
  );

  if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(`Gemini: ${e?.error?.message || r.status}`); }

  const data  = await r.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  let raw = parts.filter(p => typeof p.text==='string' && !p.thought).map(p=>p.text).join('').trim();
  if (!raw) raw = parts.filter(p => typeof p.text==='string').map(p=>p.text).join('').trim();
  if (!raw) throw new Error('Gemini 응답이 비어있습니다');

  let articles = [];
  const parsed = extractJSON(raw);
  if (parsed) {
    articles = parsed.articles || [];
  } else {
    const m = raw.match(/\{\s*"articles"\s*:\s*(\[[\s\S]*)/);
    if (m) {
      try {
        let s = m[1].replace(/,\s*\{[^}]*$/, '').replace(/,\s*$/, '');
        if (!s.endsWith(']')) s += ']';
        const rec = JSON.parse(`{"articles":${s}}`);
        if (rec.articles?.length) articles = rec.articles;
      } catch {}
    }
    if (!articles.length) throw new Error(`기사 수집 JSON 파싱 실패: ${raw.slice(0,120)}`);
  }

  // groundingMetadata URL 매칭
  const chunks   = data.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const realUrls = chunks.filter(c=>c.web?.uri).map(c=>({ url: c.web.uri, title: (c.web.title||'').toLowerCase() }));

  articles = articles.map(article => {
    const words = (article.title||'').toLowerCase().split(/\s+/).filter(w=>w.length>1);
    let best=null, bestScore=0;
    realUrls.forEach(ru => { const score=words.filter(w=>ru.title.includes(w)).length; if(score>bestScore){bestScore=score;best=ru;} });
    return { ...article, url: best?.url||'' };
  });

  const used=new Set(articles.map(a=>a.url).filter(Boolean));
  const unused=realUrls.filter(ru=>!used.has(ru.url));
  let idx=0;
  articles=articles.map(a => { if(!a.url&&idx<unused.length) return {...a,url:unused[idx++].url}; return a; });

  return articles;
}

// ── STEP 3: Claude → 리스크 분석 ─────────────────────────────────────────────
async function analyzeRisk(company, articles) {
  if (!articles.length)
    return { company, risk_factors: [], sources: [], overall_sentiment: 'neutral', skip_reason: 'no_new_news' };

  const articleText = articles
    .map((a,i) => `[${i+1}] ${a.title}\n출처: ${a.source} | 날짜: ${a.date}\n요약: ${a.summary}`)
    .join('\n\n');

  const prompt = `당신은 기업 리스크 전문 애널리스트입니다.
아래는 "${company}"에 관해 수집된 최근 14일 기사입니다. 이를 바탕으로 리스크를 분석하세요.

${articleText}

severity 기준 (엄격히 적용):
- high: 재무손실 확정 / 부채·차입금 급증 / 현금흐름 실질 악화 / 영업정지·과징금·형사기소 확정
- medium: 소송 진행중(미확정) / 규제조사 착수 / 실적둔화 가능성 / 경쟁심화
- low: 평판리스크 / 여론악화 / 임원교체 / 조직개편 / 간접적 불확실성

아래 JSON 형식으로만 출력하세요:
{"company":"${company}","risk_factors":[{"rank":1,"title":"리스크 제목","detail":"3-5문장 서술 (수치 포함)","severity":"high|medium|low"}],"sources":[{"title":"제목","url":"URL","source":"언론사","date":"날짜"}],"overall_sentiment":"positive|neutral|negative","skip_reason":null}

규칙: risk_factors 최대 3개. sources는 실제 분석에 사용한 기사만. JSON만 출력.`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
  });

  if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e?.error?.message || `Claude HTTP ${r.status}`); }
  const data   = await r.json();
  const raw    = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('').trim();
  if (!raw)    throw new Error('Claude 분석 응답이 비어있습니다');
  const parsed = extractJSON(raw);
  if (!parsed) throw new Error(`분석 JSON 파싱 실패: ${raw.slice(0,120)}`);

  if (parsed.sources?.length && articles.length) {
    parsed.sources = parsed.sources.map(src => {
      if (src.url) return src;
      const match = articles.find(a => a.title && src.title && a.title.includes(src.title.slice(0,10)));
      return { ...src, url: match?.url || '' };
    });
  }
  return parsed;
}

// ── 텔레그램 메시지 빌더 ─────────────────────────────────────────────────────
const SENT_LABEL = { positive: '긍정 📈', neutral: '중립 ➖', negative: '리스크 ⚠️' };
const SVL = { high: '상', medium: '중', low: '하' };
const SVE = { high: '🔴', medium: '🟡', low: '🔵' };

function buildTgMsg(name, res, archive) {
  // 중복: 이전 아카이브 내용으로 대체 발송
  if (res.duplicate) {
    const prev = archive[res.duplicate.date]?.[name];
    if (prev && !prev.duplicate) return buildTgMsg(name, prev, archive);
  }

  const sentiment = SENT_LABEL[res.overall_sentiment] || '중립 ➖';
  let t = `<b>━━ ${name} ━━</b>\n종합 평가: <b>${sentiment}</b>\n`;

  if (res.error) { t += `❌ ${res.error}`; return t; }

  const risks = res.risk_factors || [];
  if (!risks.length) { t += '✅ 최근 14일 내 신규 리스크 없음'; return t; }

  t += '\n';
  risks.forEach(rf => {
    t += `${SVE[rf.severity]||'🟡'} <b>[리스크 ${rf.rank}] ${rf.title}</b>  심각도: ${SVL[rf.severity]||''}\n  ${rf.detail}\n\n`;
  });

  const srcs = res.sources || [];
  if (srcs.length) {
    t += '📰 <b>검토 기사</b>\n';
    srcs.forEach((s,i) => {
      t += s.url
        ? `  ${i+1}. <a href="${s.url}">${s.title}</a> — ${s.source||''} (${s.date||''})\n`
        : `  ${i+1}. ${s.title} — ${s.source||''}\n`;
    });
  }
  return t;
}

async function tgSend(text) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(`Telegram ${r.status}: ${e?.description||''}`); }
}

// ── 메인 ──────────────────────────────────────────────────────────────────────
async function main() {
  const missing = [
    !CLAUDE_KEY       && 'ANTHROPIC_API_KEY',
    !GEMINI_KEY       && 'GEMINI_API_KEY',
    !TG_TOKEN         && 'TELEGRAM_BOT_TOKEN',
    !TG_CHAT_ID       && 'TELEGRAM_CHAT_ID',
    !COMPANIES.length && 'watchlist.txt (기업 목록이 비어있음)',
  ].filter(Boolean);
  if (missing.length) { console.error(`❌ 누락된 환경변수: ${missing.join(', ')}`); process.exit(1); }

  const today   = todayStr();
  const archive = loadArchive();
  const results = {};

  log(`🚀 분석 시작 — ${today} / ${COMPANIES.length}개 기업`);

  // 헤더 메시지
  await tgSend(`📊 <b>WATCHLIST PRO 리스크 분석</b>\n📅 ${fmt(today)} · 최근 14일\n🏢 ${COMPANIES.length}개 기업\n━━━━━━━━━━━━━━━`);

  // 기업별 3단계 파이프라인
  for (let i = 0; i < COMPANIES.length; i++) {
    const co = COMPANIES[i];
    log(`\n[${i+1}/${COMPANIES.length}] ${co}`);

    try {
      log(`  ① Claude: 검색 정책 생성`);
      const policy = await buildSearchPolicy(co);

      log(`  ② Gemini: 기사 수집 (${policy.search_queries?.join(', ')})`);
      const articles = await collectArticles(policy);
      log(`     → ${articles.length}건 수집`);

      log(`  ③ Claude: 리스크 분석`);
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

    if (i < COMPANIES.length - 1) await sleep(3000);
  }

  // 아카이브 저장 + 14일 초과분 정리
  archive[today] = results;
  const cutoff = dateFrom();
  Object.keys(archive).forEach(d => { if (d < cutoff) delete archive[d]; });
  saveArchive(archive);
  log(`\n💾 아카이브 저장 완료`);

  // 텔레그램 기업별 발송
  for (const [name, res] of Object.entries(results)) {
    await tgSend(buildTgMsg(name, res, archive));
    await sleep(500);
  }

  // 푸터 메시지
  const riskCount = Object.values(results).filter(r => r.overall_sentiment === 'negative').length;
  const dupCount  = Object.values(results).filter(r => r.duplicate).length;
  await tgSend(
    `━━━━━━━━━━━━━━━\n✅ 분석 완료\n` +
    `⚠️ 리스크 감지: ${riskCount}개 기업\n` +
    (dupCount ? `♻️ 이전 아카이브 동일: ${dupCount}개 기업` : '')
  );

  log(`🎉 완료 — 리스크 ${riskCount}건 / 중복 ${dupCount}건`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
