// Relays messages between the Venice tab (content script) and the local daemon (WebSocket).
const DEFAULTS = { port: 8765, token: '' };
let ws = null;
let tab = null; // the content-script port of the active Venice tab
let retry = null;

function toTab(msg) {
  try {
    tab?.postMessage(msg);
  } catch {
    /* tab gone */
  }
}

function toDaemon(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function scheduleRetry() {
  clearTimeout(retry);
  if (tab) retry = setTimeout(connect, 3000);
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  const { port, token } = await chrome.storage.local.get(DEFAULTS);
  if (!token) {
    toTab({ type: 'status', text: 'Token belum diisi. Buka halaman Options extension.' });
    return;
  }
  // Token goes in the subprotocol, not the URL, so it does not land in request-URL logs.
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`, ['venice-bridge', token]);
  ws = socket;
  socket.onopen = () => {
    toTab({ type: 'conn', ok: true });
    toTab({ type: 'status', text: 'Terhubung ke daemon. Menunggu perintah.' });
    toDaemon({ type: 'hello', tabReady: !!tab });
  };
  socket.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'ping') return toDaemon({ type: 'pong' });
    if (msg.type === 'send' && !tab) return toDaemon({ type: 'reply', id: msg.id, ok: false, error: 'tab Venice tidak terbuka' });
    toTab(msg);
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    toTab({ type: 'conn', ok: false });
    toTab({ type: 'status', text: 'Daemon tidak terhubung. Mencoba lagi…' });
    scheduleRetry();
  };
  socket.onerror = () => {};
}

chrome.runtime.onConnect.addListener((p) => {
  if (p.name !== 'venice-bridge') return;
  const tabId = p.sender?.tab?.id;
  // Lock onto ONE Venice tab for the whole run. A second tab (or a reopened one after the
  // first closes) must not silently become the target mid-job.
  if (tab && tab.port && tab._tabId !== tabId) {
    try {
      // Tell this tab it was rejected so it stops trying to reconnect every second.
      p.postMessage({ type: 'rejected', text: 'Tab Venice lain sudah terhubung ke bridge. Tutup tab ini atau tab yang lain.' });
    } catch { /* ignore */ }
    setTimeout(() => p.disconnect(), 50);
    return;
  }
  tab = { port: p, _tabId: tabId };
  // Keep the old helpers working: they call tab.postMessage.
  tab.postMessage = (m) => p.postMessage(m);
  p.onMessage.addListener((msg) => {
    if (msg.type === 'reply' || msg.type === 'stop') toDaemon(msg);
  });
  p.onDisconnect.addListener(() => {
    if (tab?.port !== p) return;
    tab = null;
    toDaemon({ type: 'tab', tabReady: false });
  });
  if (ws && ws.readyState === WebSocket.OPEN) {
    toTab({ type: 'conn', ok: true });
    toDaemon({ type: 'tab', tabReady: true });
  } else {
    connect();
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.token || changes.port) {
    ws?.close();
    ws = null;
    connect();
  }
});
