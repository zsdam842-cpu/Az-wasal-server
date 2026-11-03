// اختبار قبول لميزات وصال الجديدة: التسليم والقراءة، الحذف، الحالات، مؤشر الكتابة
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io } from 'socket.io-client';

const PORT = 3210;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), 'wasal-test-'));

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

function socketConnect(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token }, transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('SOCKET_CONNECT_TIMEOUT')), 5000);
  });
}

function waitForEvent(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`EVENT_TIMEOUT:${event}`)), timeoutMs);
    socket.once(event, payload => {
      clearTimeout(t);
      resolve(payload);
    });
  });
}

let passed = 0;
function ok(name, condition) {
  if (!condition) throw new Error(`ASSERTION_FAILED: ${name}`);
  passed++;
  console.log(`PASS: ${name}`);
}

try {
  await waitForServer();
  ok('server starts and /health responds', true);

  // تسجيل حسابين
  const regA = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'سالم' })
  }).then(r => r.json());
  const regB = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'عمر' })
  }).then(r => r.json());

  const codeA = regA.user.wasalCode;
  const codeB = regB.user.wasalCode;
  const tokenA = regA.accessToken;
  const tokenB = regB.accessToken;

  ok('register returns 15-char wasal code', /^[A-Za-z0-9]{15}$/.test(codeA) && /^[A-Za-z0-9]{15}$/.test(codeB));
  ok('register returns access + refresh tokens', Boolean(tokenA && regA.refreshToken));

  const authA = { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` };
  const authB = { 'content-type': 'application/json', authorization: `Bearer ${tokenB}` };

  // إرسال رسالة من A إلى B
  const sent = await fetch(`${BASE}/api/messages`, {
    method: 'POST',
    headers: authA,
    body: JSON.stringify({ receiverCode: codeB, type: 'text', content: 'مرحبا عمر' })
  }).then(r => r.json());
  ok('message send returns 201 body', sent.ok === true && sent.message.id > 0);
  const msgId = sent.message.id;

  // B يتصل → A يجب أن يستلم message_delivered
  // (A يتصل أولًا حتى يكون مستمعًا في غرفته قبل لحظة اتصال B)
  const sockA = await socketConnect(tokenA);
  const sockB = await socketConnect(tokenB);
  const deliveredEv = await waitForEvent(sockA, 'message_delivered');
  ok('sender receives message_delivered on receiver connect',
    deliveredEv.messageIds.includes(msgId));

  // B يجلب الرسائل → A يستلم message_read
  const readPromise = waitForEvent(sockA, 'message_read');
  await fetch(`${BASE}/api/conversations/${codeA}/messages`, { headers: authB });
  const readEv = await readPromise;
  ok('sender receives message_read after receiver fetches', readEv.messageIds.includes(msgId));

  // مؤشر الكتابة
  const typingPromise = waitForEvent(sockB, 'typing');
  sockA.emit('typing', { to: codeB, isTyping: true });
  const typingEv = await typingPromise;
  ok('receiver receives typing indicator', typingEv.from === codeA && typingEv.isTyping === true);

  // حذف لدى الجميع (المرسل)
  const delPromise = waitForEvent(sockB, 'message_deleted');
  const delRes = await fetch(`${BASE}/api/messages/${msgId}?scope=everyone`, {
    method: 'DELETE', headers: authA
  }).then(r => r.json());
  ok('delete for everyone succeeds by sender', delRes.ok === true && delRes.scope === 'everyone');
  await delPromise;

  const listB = await fetch(`${BASE}/api/conversations/${codeA}/messages`, { headers: authB })
    .then(r => r.json());
  ok('deleted-for-everyone message hidden from receiver',
    !listB.messages.some(m => m.id === msgId));

  // حذف لدي فقط (المستقبل يحذف رسالة من المرسل)
  const sent2 = await fetch(`${BASE}/api/messages`, {
    method: 'POST', headers: authA,
    body: JSON.stringify({ receiverCode: codeB, type: 'text', content: 'رسالة ثانية' })
  }).then(r => r.json());
  const delMe = await fetch(`${BASE}/api/messages/${sent2.message.id}?scope=me`, {
    method: 'DELETE', headers: authB
  }).then(r => r.json());
  ok('delete for me succeeds', delMe.ok === true && delMe.scope === 'me');

  const listB2 = await fetch(`${BASE}/api/conversations/${codeA}/messages`, { headers: authB })
    .then(r => r.json());
  const listA2 = await fetch(`${BASE}/api/conversations/${codeB}/messages`, { headers: authA })
    .then(r => r.json());
  ok('delete-for-me hides from deleter only',
    !listB2.messages.some(m => m.id === sent2.message.id) &&
    listA2.messages.some(m => m.id === sent2.message.id));

  // تفاعلات الرسائل (قلب/إعجاب)
  const sent3 = await fetch(`${BASE}/api/messages`, {
    method: 'POST', headers: authA,
    body: JSON.stringify({ receiverCode: codeB, type: 'text', content: 'رسالة للتفاعل' })
  }).then(r => r.json());
  const reactTargetId = sent3.message.id;

  const reactionPromise = waitForEvent(sockA, 'message_reaction');
  const reactRes = await fetch(`${BASE}/api/messages/${reactTargetId}/reactions`, {
    method: 'POST', headers: authB,
    body: JSON.stringify({ emoji: '❤️' })
  }).then(r => r.json());

  ok('reaction added by receiver', reactRes.ok === true && reactRes.action === 'set' &&
    reactRes.reactions.some(x => x.userCode === codeB && x.emoji === '❤️'));

  const reactionEv = await reactionPromise;
  ok('sender receives message_reaction over socket',
    reactionEv.messageId === reactTargetId && reactionEv.emoji === '❤️' && reactionEv.action === 'set');

  const listReact = await fetch(`${BASE}/api/conversations/${codeB}/messages`, { headers: authA })
    .then(r => r.json());
  const reactMsg = listReact.messages.find(m => m.id === reactTargetId);
  ok('reaction is part of the message payload', reactMsg && reactMsg.reactions.length === 1);

  const toggleRes = await fetch(`${BASE}/api/messages/${reactTargetId}/reactions`, {
    method: 'POST', headers: authB,
    body: JSON.stringify({ emoji: '❤️' })
  }).then(r => r.json());
  ok('same emoji again removes the reaction',
    toggleRes.action === 'removed' && toggleRes.reactions.length === 0);

  const likeRes = await fetch(`${BASE}/api/messages/${reactTargetId}/reactions`, {
    method: 'POST', headers: authA,
    body: JSON.stringify({ emoji: '👍' })
  }).then(r => r.json());
  ok('sender can react too', likeRes.action === 'set' && likeRes.reactions.length === 1);

  const badReaction = await fetch(`${BASE}/api/messages/${reactTargetId}/reactions`, {
    method: 'POST', headers: authA,
    body: JSON.stringify({ emoji: '🚀' })
  });
  ok('unsupported emoji rejected with 400', badReaction.status === 400);

  const clearReaction = await fetch(`${BASE}/api/messages/${reactTargetId}/reactions`, {
    method: 'DELETE', headers: authA
  }).then(r => r.json());
  ok('explicit delete clears own reaction',
    clearReaction.action === 'removed' && clearReaction.reactions.length === 0);

  // الرد على رسالة (اقتباس)
  const replyRes = await fetch(`${BASE}/api/messages`, {
    method: 'POST', headers: authB,
    body: JSON.stringify({
      receiverCode: codeA, type: 'text', content: 'رد على رسالتك', replyToId: reactTargetId
    })
  }).then(r => r.json());
  ok('reply send keeps quoted message', replyRes.message.replyToId === reactTargetId &&
    replyRes.message.replyTo && replyRes.message.replyTo.id === reactTargetId);

  const listReply = await fetch(`${BASE}/api/conversations/${codeA}/messages`, { headers: authB })
    .then(r => r.json());
  const replyMsg = listReply.messages.find(m => m.id === replyRes.message.id);
  ok('reply payload is returned when listing messages',
    replyMsg && replyMsg.replyTo && replyMsg.replyTo.content === 'رسالة للتفاعل');

  const badReply = await fetch(`${BASE}/api/messages`, {
    method: 'POST', headers: authA,
    body: JSON.stringify({ receiverCode: codeB, type: 'text', content: 'اقتباس خاطئ', replyToId: 999999 })
  });
  ok('reply to unknown message rejected with 400', badReply.status === 400);

  // الصورة الشخصية
  const avatarUrl = 'https://az-wasal-media-server-production.up.railway.app/uploads/avatar-test.png';

  const setAvatar = await fetch(`${BASE}/api/users/me/avatar`, {
    method: 'PUT', headers: authB,
    body: JSON.stringify({ avatarUrl })
  }).then(r => r.json());
  ok('avatar saved on the profile', setAvatar.ok === true &&
    setAvatar.user.avatarUrl === avatarUrl);

  const meAfterAvatar = await fetch(`${BASE}/api/users/me`, { headers: authB })
    .then(r => r.json());
  ok('GET /api/users/me returns the avatar', meAfterAvatar.user.avatarUrl === avatarUrl);

  const convForAvatar = await fetch(`${BASE}/api/conversations`, { headers: authA })
    .then(r => r.json());
  const convUser = (convForAvatar.conversations || []).find(c => c.otherCode === codeB);
  ok('conversation payload carries the other user avatar',
    convUser && convUser.user && convUser.user.avatarUrl === avatarUrl);

  const badAvatar = await fetch(`${BASE}/api/users/me/avatar`, {
    method: 'PUT', headers: authB,
    body: JSON.stringify({ avatarUrl: 'https://evil.example.com/a.png' })
  });
  ok('foreign avatar host rejected with 400', badAvatar.status === 400);

  const clearAvatar = await fetch(`${BASE}/api/users/me/avatar`, {
    method: 'PUT', headers: authB,
    body: JSON.stringify({ avatarUrl: '' })
  }).then(r => r.json());
  ok('avatar can be removed', clearAvatar.ok === true && clearAvatar.user.avatarUrl === null);

  // الحالات
  const st = await fetch(`${BASE}/api/statuses`, {
    method: 'POST', headers: authA,
    body: JSON.stringify({ type: 'text', text: 'حالة سالم' })
  }).then(r => r.json());
  ok('create text status returns 201 body', st.ok === true && st.status.type === 'text');

  const stList = await fetch(`${BASE}/api/statuses`, { headers: authB }).then(r => r.json());
  ok('contact sees the status in list', stList.statuses.some(s => s.id === st.status.id));

  await fetch(`${BASE}/api/statuses/${st.status.id}/view`, {
    method: 'POST', headers: authB
  });
  const stListA = await fetch(`${BASE}/api/statuses`, { headers: authA }).then(r => r.json());
  const mine = stListA.statuses.find(s => s.id === st.status.id);
  ok('status view recorded with viewer count', mine && mine.viewsCount === 1);

  const stDel = await fetch(`${BASE}/api/statuses/${st.status.id}`, {
    method: 'DELETE', headers: authA
  }).then(r => r.json());
  ok('author deletes own status', stDel.ok === true);

  const stDelB = await fetch(`${BASE}/api/statuses/${st.status.id}`, {
    method: 'DELETE', headers: authB
  });
  ok('non-author cannot delete status', stDelB.status === 404);

  sockA.disconnect();
  sockB.disconnect();
  console.log(`\nALL ${passed} TESTS PASSED`);
  process.exitCode = 0;
} catch (err) {
  console.error(`TEST FAILED: ${err.message}`);
  console.error(err.stack?.split('\n')[1] || '');
  process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
  // عملاء socket.io يمنعون خروج العملية تلقائيًا
  setTimeout(() => process.exit(process.exitCode || 0), 500).unref();
}
