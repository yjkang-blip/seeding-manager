// scripts/capture-screenshots.js
// 매일 실행: 주간 시딩 리스트에 등록된 postUrl 중 아직 백업 캡처가 없는 게시물을
// 헤드리스 브라우저로 스크린샷 찍어서 저장소의 screenshots/ 폴더에 파일로 저장하고,
// Firestore의 screenshots 배열에 (GitHub Pages로 접근 가능한) URL을 기록합니다.
//
// ★ 이 버전은 firebase-admin(서비스 계정 키)이 필요 없습니다.
//   index.html이 이미 사용하고 있는 것과 같은 "공개 API 키"로 Firestore REST API를
//   직접 호출합니다. Firebase 보안 규칙이 열려있는(로그인 없이 읽기/쓰기 가능) 이
//   프로젝트 구조에 맞춘 방식입니다.
//
// 필요한 것: 없음 (GitHub Secrets 등록도 필요 없음, 워크플로우 파일에 이미 값이 들어있음)

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.FIREBASE_API_KEY;
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const PAGES_BASE_URL = (process.env.PAGES_BASE_URL || '').replace(/\/$/, '');
const DOC_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/seeding/main`;
const SCREENSHOTS_DIR = path.join(__dirname, '..', 'screenshots');

// ── Firestore REST <-> 일반 JS 변환 헬퍼 ──
function fsToJs(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fsToJs);
  if ('mapValue' in v) {
    const obj = {};
    const f = v.mapValue.fields || {};
    for (const k in f) obj[k] = fsToJs(f[k]);
    return obj;
  }
  return null;
}
function jsToFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(jsToFs) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const k in v) fields[k] = jsToFs(v[k]);
    return { mapValue: { fields } };
  }
  return { nullValue: null };
}

function normUrl(u) {
  if (!u) return '';
  return u.trim().split('?')[0].replace(/\/$/, '').toLowerCase();
}
function todayKST() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}
function isYoutube(u) {
  return /youtube\.com|youtu\.be/i.test(u || '');
}
function toEmbedUrl(u) {
  if (isYoutube(u)) {
    let id = '', m;
    if ((m = u.match(/[?&]v=([^&]+)/))) id = m[1];
    else if ((m = u.match(/youtu\.be\/([^?&]+)/))) id = m[1];
    else if ((m = u.match(/youtube\.com\/shorts\/([^?&]+)/))) id = m[1];
    return id ? `https://www.youtube.com/embed/${id}` : null;
  }
  const clean = u.split('?')[0].replace(/\/$/, '');
  return `${clean}/embed/captioned/`;
}

async function main() {
  if (!API_KEY || !PROJECT_ID || !PAGES_BASE_URL) {
    console.error('환경변수(FIREBASE_API_KEY / FIREBASE_PROJECT_ID / PAGES_BASE_URL)가 설정되지 않았습니다.');
    process.exit(1);
  }

  // 1) 문서 읽기
  const getRes = await fetch(`${DOC_URL}?key=${API_KEY}`);
  const getJson = await getRes.json();
  if (!getJson.fields) {
    console.error('문서를 읽을 수 없습니다:', JSON.stringify(getJson));
    process.exit(1);
  }

  const weekly = fsToJs(getJson.fields.weekly) || [];
  const screenshots = fsToJs(getJson.fields.screenshots) || [];
  const existingUrls = new Set(screenshots.map((s) => normUrl(s.postUrl)));

  const targets = [];
  weekly.forEach((w) => {
    (w.people || []).forEach((p) => {
      const urls = [].concat(p.postUrls || [], p.postUrl ? [p.postUrl] : []).filter(Boolean);
      urls.forEach((u) => {
        if (!existingUrls.has(normUrl(u)) && !targets.some((t) => normUrl(t) === normUrl(u))) {
          targets.push(u);
        }
      });
    });
  });

  if (targets.length === 0) {
    console.log('새로 캡처할 게시물이 없습니다. 종료합니다.');
    return;
  }
  console.log(`${targets.length}개 게시물 캡처 시작`);

  if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 540, height: 800 });

  const today = todayKST();
  let captured = 0;

  for (const url of targets) {
    try {
      const embedUrl = toEmbedUrl(url);
      if (!embedUrl) continue;
      await page.goto(embedUrl, { waitUntil: 'networkidle2', timeout: 20000 });
      await new Promise((r) => setTimeout(r, 1500));
      const buffer = await page.screenshot({ type: 'png' });

      const safeId = normUrl(url).replace(/[^a-z0-9]/gi, '_').slice(0, 80);
      const fileName = `${safeId}.png`;
      fs.writeFileSync(path.join(SCREENSHOTS_DIR, fileName), buffer);

      const publicUrl = `${PAGES_BASE_URL}/screenshots/${fileName}`;
      screenshots.push({ postUrl: url, url: publicUrl, capturedAt: today });
      captured++;
      console.log('캡처 완료:', url);
    } catch (err) {
      console.error('캡처 실패:', url, err.message);
    }
  }

  await browser.close();

  if (captured > 0) {
    // 2) screenshots 필드만 업데이트 (updateMask로 다른 필드는 안 건드림)
    const patchUrl = `${DOC_URL}?key=${API_KEY}&updateMask.fieldPaths=screenshots`;
    const body = { fields: { screenshots: jsToFs(screenshots) } };
    const patchRes = await fetch(patchUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const patchJson = await patchRes.json();
    if (patchJson.error) {
      console.error('Firestore 업데이트 실패:', JSON.stringify(patchJson.error));
      process.exit(1);
    }
  }

  console.log(`총 ${captured}개 캡처 및 저장 완료`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
