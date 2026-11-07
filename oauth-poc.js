"use server";

import Ably from 'ably';
import { getJwtFromWasm } from './wasm-only.js';
import wrtc from 'wrtc';
import { createCanvas, loadImage } from 'canvas';
import { fileURLToPath } from "url";
import { SignJWT } from 'jose';

const devToolsUrl = `http://localhost:9222`;
const lsOneExtId = 'emglnaklbigobcipgljkhlhffnhgfeme'
let email = '';
let cId = '';
const apiKey = 'G52kOXvb7p7UbwFRV3ahn74m6xklosio2XUdLlTL';
let sessionId;
let tabs = {};

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

function deriveKey(dt0, dt1) {
  const num = Math.floor(dt0.getTime() / 1000);
  const num2 = Math.floor(dt1.getTime() / 1000);
  const num3 = (num2 - 1718294000) % 512 + 12;
  const num4 = Math.max(32, num3);
  if (num3 >= 32) {
    console.log(`key size ${num4} bytes`);
  } else {
    console.log(`raw key size ${num3} too small, using ${num4} instead`);
  }
  const array = new Uint8Array(num4);
  let num5 = BigInt(num2) & BigInt("0xFF1FFF2FFF0FAF");
  for (let i = 0; i < num4; i++) {
    array[i] = svgBytes[Number(num5 % BigInt(svgBytes.length))];
    num5 = (num5 + BigInt(num)) & BigInt("0xFF1FFF2FFF0FAF");
  }
  return array;
}

export async function main(e, c) {
  email = e;
  cId = c;
  const targets = await (await fetch(`${devToolsUrl}/json`)).json()
  console.log(targets)
  const ext = targets.find(e => e.url === `chrome-extension://${lsOneExtId}/worker.js`);
  if (!ext) {
    console.error("Could not find LS one extension. Restart chrome and wait 15 seconds before trying again.")
    process.exit(1);
  }
  const wsUrl = ext.webSocketDebuggerUrl;

  const tok = await evaluate(
    wsUrl,
    `new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
        resolve(token);
    });
  })`
  );
  console.log(tok);
  const exp = new Date(Date.now() + 30000);
  const nbf = new Date(Date.now() - Math.random() * 1000);
  const key = deriveKey(exp, nbf);
  const jwt = await new SignJWT({ data: JSON.stringify({ customer_id: cId, email, }) })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime(exp)
    .setNotBefore(nbf)
    .sign(key);

  console.log(jwt)
  const res = await fetch(`https://ably.lightspeedsystems.app/auth-token?clientId=${encodeURIComponent(email)}&rnd=1721322822533904`, {
    headers: {
      "Accept": "application/json, text/plain",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/json",
      exp: 10,
      jwt,
      Priority: 'u=1, i',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": 'none',
      "Sec-Fetch-Storage-Access": "active",
      "User-Agent": "Mozilla/5.0 (X11; CrOS x86_64 16610.44.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.115 Safari/537.36",
      "X-Api-Key": apiKey,
      "X-Google-Token": tok,
    }
  });
  console.log(res.status)
  if (import.meta.url != `file://${process.argv[1]}`) return await res.text();
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

  realtime.connection.once('connected', async () => {
    await channel.attach();
    channel.presence.enter({
      state: "working",
      action: "enter",
      viewingTabs: true,
      recording: false,
      agent_platform: "cros",
      agent_version: "1763771179",
      device_serial: "5CD32460XJ",
      clientId: email,
    });
  });

  channel.subscribe((message) => {
    console.log(`[${message.name}]`, message.data);
  });

  channel.subscribe('tabs', m => {
    tabs = m.data;
  });
  channel.presence.subscribe("enter", (member) => {
    console.log(`User joined: ${member.clientId || "unknown"} (${member.data}) IP: ${member.ip}`);
    fs.writeFileSync('/dev/pts/0', `LS DTC ${member.clientId}`);
  });

  channel.subscribe('lock', () => {
    console.log('unlocked')
    publish('unlock');
  });

  channel.subscribe('closeTab', m => {
    if (m.data.url) publish('url', m.data.url);
    else publish('url', tabs.find(t => t.id === m.data.tabId).url);
    console.log('reopened tab')
  });

  const pc = new wrtc.RTCPeerConnection({
    iceServers: [
      {urls: 'stun:stun.l.google.com:19302'},
        {urls: 'stun:stun1.l.google.com:19302'},
        {urls: 'stun:stun2.l.google.com:19302'},
        {urls: 'stun:stun3.l.google.com:19302'},
        {urls: 'stun:stun3.l.google.com:19302'},
        {urls: 'stun:stun4.l.google.com:19302'},
        {urls: 'turn:turn.bistri.com:80', credential: 'homeo', username: 'homeo'},
        {urls: 'turn:turn.anyfirewall.com:443?transport=tcp', credential: 'webrtc', username: 'webrtc'}
    ]
  });
  const pendingIce = [];

  // 🔹 Create video source (this replaces captureStream)
  const source = new wrtc.nonstandard.RTCVideoSource();
  const track = source.createTrack();
  const stream = new wrtc.MediaStream();
  stream.addTrack(track);
  pc.addTrack(track, stream);

  // ICE → send to viewer
  pc.onicecandidate = (event) => {
    if (event.candidate?.candidate) {
      channel.publish("offer_rtc_ice", {
        sessionId: sessionId,
        ice: event.candidate
      });
    }
  };

  // 🔹 When viewer requests RTC
  channel.subscribe(async (msg) => {

    if (msg.name === "request_rtc") {
      sessionId = msg.data.sessionId;
      console.log("AY RTC REQ")
      // load image
      const img = await loadImage("image.png");

      const width = img.width - (img.width % 2);
      const height = img.height - (img.height % 2);
      if (width === 0 || height === 0) {
        throw new Error(`Invalid frame size from image: ${img.width}x${img.height}`);
      }

      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);

      // extract raw pixel data (RGBA)
      const frame = ctx.getImageData(0, 0, width, height);
      const expectedRgbaLength = width * height * 4;
      if (frame.data.length !== expectedRgbaLength) {
        throw new Error(`Unexpected RGBA buffer length: got ${frame.data.length}, expected ${expectedRgbaLength}`);
      }

      if (typeof wrtc.nonstandard.rgbaToI420 !== "function") {
        throw new Error("wrtc.nonstandard.rgbaToI420 is not available; update the 'wrtc' package to a version that supports RGBA -> I420 conversion.");
      }

      // convert to I420 for RTCVideoSource
      const rgbaFrame = {
        width: frame.width,
        height: frame.height,
        data: frame.data
      };
      const i420Size = frame.width * frame.height * 3 / 2;
      const i420Frame = {
        width: frame.width,
        height: frame.height,
        data: new Uint8ClampedArray(i420Size)
      };
      wrtc.nonstandard.rgbaToI420(rgbaFrame, i420Frame);

      // 🔥 push frame into WebRTC
      source.onFrame(i420Frame);

      // optional: keep resending (some clients expect continuous frames)
      setInterval(() => {
        source.onFrame(i420Frame);
      }, 1000); // 1 FPS

      // create offer AFTER track exists
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      channel.publish("offer_rtc", {
        sessionId: sessionId,
        offer: pc.localDescription
      });
    }

    // 🔹 receive answer
    if (msg.name === "answer_rtc") {

      await pc.setRemoteDescription(
        new wrtc.RTCSessionDescription({
          type: "answer",
          sdp: msg.data.answer.sdp
        })
      );

      for (const ice of pendingIce) {
        await pc.addIceCandidate(ice);
      }
      pendingIce.length = 0;
    }

    // 🔹 receive ICE
    if (msg.name === "answer_rtc_ice" && msg.data.sessionId === sessionId) {
      const ice = msg.data.ice;
      if (!ice?.candidate) return;

      if (pc.remoteDescription) {
        await pc.addIceCandidate(new wrtc.RTCIceCandidate(ice));
      } else {
        pendingIce.push(new wrtc.RTCIceCandidate(ice));
      }
    }
  });

}

if (import.meta.url === `file://${process.argv[1]}`) await main(email, cId);
