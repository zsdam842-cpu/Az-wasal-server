// اختبار قبول للرمز السري ونقل الحساب بين الهواتف والنسخ الاحتياطي
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 3211;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), 'wasal-security-'));

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

function jsonPost(path, body, token) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

function jsonGet(path, token) {
  return fetch(`${BASE}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
}

try {
  await waitForServer();

  const reg = await jsonPost('/api/auth/register', { displayName: 'صدام' });
  const regBody = await reg.json();
  const token = regBody.accessToken;
  const code = regBody.user.code;
  ok('register returns a session', Boolean(token) && Boolean(code));

  // لا رمز سري بعد
  let security = await (await jsonGet('/api/auth/security', token)).json();
  ok('no secret initially', security.hasSecret === false);
  ok('two changes available', security.remainingChanges === 2);

  // تعيين الرمز السري
  const setSecret = await jsonPost('/api/auth/secret', { secret: '966368' }, token);
  ok('secret set', setSecret.status === 200);

  // محاولة تعيين ثانية مرفوضة
  const setAgain = await jsonPost('/api/auth/secret', { secret: '111111' }, token);
  ok('second set rejected', setAgain.status === 409);

  // دخول برمز خاطئ
  const badLogin = await jsonPost('/api/auth/secret/login', {
    code,
    secret: '000000',
    deviceId: 'device-B'
  });
  ok('wrong secret rejected', badLogin.status === 403);

  // دخول صحيح من هاتف آخر
  const login = await jsonPost('/api/auth/secret/login', {
    code,
    secret: '966368',
    deviceId: 'device-B',
    deviceName: 'هاتف جديد'
  });
  const loginBody = await login.json();
  ok('secret login creates transfer request', Boolean(loginBody.requestId));

  // الهاتف القديم يقرأ رمز التأكيد
  const pending = await (await jsonGet('/api/auth/transfer/pending', token)).json();
  ok('old device sees verification code', pending.requests.length === 1);
  const verification = pending.requests[0].code;
  ok('verification code is six digits', /^\d{6}$/.test(verification));

  // تأكيد خاطئ
  const wrongVerify = await jsonPost('/api/auth/secret/verify', {
    requestId: loginBody.requestId,
    code: '000000'
  });
  ok('wrong verification rejected', wrongVerify.status === 403);

  // تأكيد صحيح
  const verify = await jsonPost('/api/auth/secret/verify', {
    requestId: loginBody.requestId,
    code: verification,
    deviceId: 'device-B'
  });
  const verifyBody = await verify.json();
  ok('verification issues a new session', Boolean(verifyBody.accessToken));
  ok('new session belongs to same account', verifyBody.user.code === code);

  // إعادة استخدام نفس الطلب مرفوضة
  const reuse = await jsonPost('/api/auth/secret/verify', {
    requestId: loginBody.requestId,
    code: verification
  });
  ok('used request cannot be reused', reuse.status === 400);

  // تغيير الرمز السري مرتين ثم الحظر
  const change1 = await jsonPost(
    '/api/auth/secret/change',
    { currentSecret: '966368', newSecret: '112233', deviceId: 'device-A' },
    token
  );
  const change1Body = await change1.json();
  ok('first change succeeds', change1.status === 200);
  ok('one attempt left warning', change1Body.remainingChanges === 1 && Boolean(change1Body.warning));

  const change2 = await jsonPost(
    '/api/auth/secret/change',
    { currentSecret: '112233', newSecret: '445566', deviceId: 'device-A' },
    token
  );
  const change2Body = await change2.json();
  ok('second change succeeds', change2.status === 200);
  ok('no attempts left', change2Body.remainingChanges === 0);

  const change3 = await jsonPost(
    '/api/auth/secret/change',
    { currentSecret: '445566', newSecret: '778899', deviceId: 'device-A' },
    token
  );
  ok('third change blocked on this device', change3.status === 403);

  const securityAfter = await (await jsonGet('/api/auth/security?deviceId=device-A', token)).json();
  ok('device reports blocked', securityAfter.deviceBlocked === true);

  // بريد النسخ الاحتياطي
  const badEmail = await jsonPost('/api/auth/backup-email', { email: 'not-an-email' }, token);
  ok('invalid email rejected', badEmail.status === 400);

  const email = await jsonPost('/api/auth/backup-email', { email: 'backup@example.com' }, token);
  ok('backup email saved', email.status === 200);

  // نسخة احتياطية
  const backup = await jsonPost('/api/auth/backup', { payload: '{"messages":[]}' }, token);
  ok('backup uploaded', backup.status === 200);

  const restored = await (await jsonGet('/api/auth/backup', token)).json();
  ok('backup restored', restored.payload === '{"messages":[]}');

  console.log(`\nALL ${passed} SECURITY TESTS PASSED`);
  server.kill();
  process.exit(0);
} catch (error) {
  console.error('SECURITY TESTS FAILED:', error.message);
  server.kill();
  process.exit(1);
}
