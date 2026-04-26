import Ably from 'ably';
import { getJwtFromWasm } from './wasm-only.js';

const devToolsUrl = `http://localhost:9222`;
const lsOneExtId = 'emglnaklbigobcipgljkhlhffnhgfeme'
const email = '1853413@fcpsschools.net';
const cId = '61-6373-A000';

function cdpSession(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let msgId = 1;
    const pending = new Map();

    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => {
      const send = (method, params = {}) => new Promise((res, rej) => {
        const id = msgId++;
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      });

      const close = () => ws.close();

      resolve({ send, close });
    });

    ws.addEventListener('message', ({ data }) => {
      const msg = JSON.parse(data);
      if (!msg.id) return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.rej(new Error(msg.error.message));
      else p.res(msg.result);
    });
  });
}

async function evaluate(wsUrl, expression) {
  const { send, close } = await cdpSession(wsUrl);
  try {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise:   true,
      returnByValue:  true,
      timeout:        10000,
    });
    return result?.result?.value;
  } finally {
    close();
  }
}

const targets = await (await fetch(`${devToolsUrl}/json`)).json()
const wsUrl = targets.find(e => e.url === `chrome-extension://${lsOneExtId}/worker.js`).webSocketDebuggerUrl;

const token = await evaluate(
  wsUrl,
  `new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
        resolve(token);
    });
  })`
);

const jwt = await getJwtFromWasm();
console.log(jwt)
const res = await fetch(`https://ably.lightspeedsystems.app/?clientId=${encodeURIComponent(email)}`, {
  headers: {
    "Content-Type": "application/json",
    "X-API-Key": 'G52kOXvb7p7UbwFRV3ahn74m6xklosio2XUdLlTL',
    "User-Agent": "Mozilla/5.0 (X11; CrOS x86_64 16610.44.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.115 Safari/537.36",
    jwt,
    exp: '10',
  }
});
console.log(res.status)

const realtime = new Ably.Realtime({
  authCallback: async (_, callback) => {
    callback(null, await res.text())
  },
  clientId: email,
  autoConnect: false,
  echoMessages: true,
  endpoint: "lightspeed",
  fallbackHosts: ["a-fallback-lightspeed.ably.io", "b-fallback-lightspeed.ably.io", "c-fallback-lightspeed.ably.io"],
})

const publish = (type, content) => {
  realtime.channels
    .get(`${cId}:${email}`)
    .publish(type, content);
};

realtime.connection.on('connecting', () => {
  console.log("ably connecting")
})

realtime.connection.on('connected', () => {
  console.log("ably connected ", realtime.connection.id, email)
})

realtime.connection.on('failed', (e) => {
  console.log("ably failed ", e)
})

realtime.connect();

const channel = realtime.channels.get(`${cId}:${email}`)

channel.subscribe((message) => {
  console.log(`[${message.name}]`, message.data);
});
