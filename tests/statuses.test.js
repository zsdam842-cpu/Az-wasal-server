// اختبار قبول للحالات: وسائط، جمهور، إعجاب، مشاهدون، حذف
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 3212;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), 'wasal-statuses-'));

const server = spawn(process.execPath, ['server.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    JWT_SECRET: 'test-secret',
    DATA_DIR: join(dataDir, 'data'),
    MEDIA_DIR: join(dataDir, 'media')
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

server.stderr.on('data', d => process.stderr.write(d));

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('SERVER_DID_NOT_START');
}

let passed = 0;
function ok(name, condition) {
  if (!condition) throw new Error(`ASSERTION_FAILED: ${name}`);
  passed++;
  console.log(`PASS: ${name}`);
}

async function api(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: response.status, json };
}

try {
  await waitForServer();

  const a = await api('/api/auth/register', { method: 'POST', body: { displayName: 'أحمد' } });
  const b = await api('/api/auth/register', { method: 'POST', body: { displayName: 'سالم' } });

  const tokenA = a.json.accessToken;
  const tokenB = b.json.accessToken;
  const codeA = a.json.user.code;
  const codeB = b.json.user.code;

  // محادثة بين الاثنين (ليصبحا جهات اتصال)
  const conv = await api('/api/conversations', {
    method: 'POST',
    body: { wasalCode: codeB },
    token: tokenA
  });
  ok('conversation created', conv.status === 201 || conv.status === 200);

  // حالة نصية للجميع
  const textStatus = await api('/api/statuses', {
    method: 'POST',
    body: { type: 'text', text: 'مرحبا', audience: 'everyone' },
    token: tokenA
  });
  ok('text status published', textStatus.status === 201);
  ok('audience stored', textStatus.json.status.audience === 'everyone');

  // حالة صورة
  const imageStatus = await api('/api/statuses', {
    method: 'POST',
    body: {
      type: 'image',
      mediaUrl: `${BASE}/media/example.jpg`,
      audience: 'contacts'
    },
    token: tokenA
  });
  ok('image status published', imageStatus.status === 201);
  ok('image url returned', String(imageStatus.json.status.mediaUrl || '').includes('example.jpg'));
  const imageId = imageStatus.json.status.id;

  // جهة الاتصال ترى الحالتين
  const listB = await api('/api/statuses', { token: tokenB });
  ok('contact sees statuses', listB.json.statuses.length === 2);

  // مشاهدة + إعجاب
  const view = await api(`/api/statuses/${imageId}/view`, { method: 'POST', token: tokenB });
  ok('view recorded', view.status === 200);

  const like = await api(`/api/statuses/${imageId}/like`, { method: 'POST', token: tokenB });
  ok('like recorded', like.status === 200 && like.json.likesCount === 1);

  const ownLike = await api(`/api/statuses/${imageId}/like`, { method: 'POST', token: tokenA });
  ok('author cannot like own status', ownLike.status === 400);

  // صاحب الحالة يرى المشاهدين والإعجابات
  const viewers = await api(`/api/statuses/${imageId}/viewers`, { token: tokenA });
  ok('author sees viewers', viewers.json.viewers.length === 1);
  ok('author sees likes', viewers.json.likes.length === 1);
  ok('viewer name returned', viewers.json.viewers[0].name === 'سالم');

  const foreign = await api(`/api/statuses/${imageId}/viewers`, { token: tokenB });
  ok('non-author cannot read viewers', foreign.status === 403);

  // الحالة لا تظهر لصاحبها فقط: تظهر له أيضاً في قائمته
  const listA = await api('/api/statuses', { token: tokenA });
  ok('author sees own statuses', listA.json.statuses.length === 2);

  // إلغاء الإعجاب
  const unlike = await api(`/api/statuses/${imageId}/like`, { method: 'DELETE', token: tokenB });
  ok('unlike works', unlike.json.likesCount === 0);

  // حذف الحالة ينظف المشاهدات
  const del = await api(`/api/statuses/${imageId}`, { method: 'DELETE', token: tokenA });
  ok('delete own status', del.status === 200);

  const listAfter = await api('/api/statuses', { token: tokenA });
  ok('deleted status disappears', listAfter.json.statuses.length === 1);

  console.log(`\nALL ${passed} STATUS TESTS PASSED`);
  server.kill();
  process.exit(0);
} catch (error) {
  console.error('STATUS TESTS FAILED:', error.message);
  server.kill();
  process.exit(1);
}
