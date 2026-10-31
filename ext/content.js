// Wires the DOM driver to the background service worker and shows a small status panel.
(() => {
  if (globalThis.__veniceBridgeLoaded) return;
  globalThis.__veniceBridgeLoaded = true;

  const KEYS = ['input', 'sendButton', 'stopButton', 'assistantMessage', 'excludeInMessage', 'newChatButton', 'modelLabel', 'modelOption'];
  let selectors = { ...globalThis.VB_DEFAULT_SELECTORS };
  let driver = new globalThis.VeniceDriver(selectors);
  let port = null;
  let busy = false;
  let reloadQueued = false;
  let noReconnect = false;

  async function loadSelectors() {
    const { selectors: saved } = await chrome.storage.local.get({ selectors: {} });
    selectors = { ...globalThis.VB_DEFAULT_SELECTORS, ...saved };
    // Never swap the driver out from under a running job, or Stop would cancel the wrong one.
    if (busy) {
      reloadQueued = true;
      return;
    }
    driver = new globalThis.VeniceDriver(selectors);
  }

  // ---------- panel (visible, labelled; it is a control surface, not hidden) ----------
  const host = document.createElement('div');
  host.setAttribute('data-venice-bridge', 'panel');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      .box { position: fixed; right: 12px; bottom: 12px; z-index: 2147483647; width: 280px;
             font: 12px/1.4 system-ui, sans-serif; background: #111; color: #eee; border: 1px solid #444;
             border-radius: 8px; padding: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.4); }
      .row { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
      button { font: inherit; background: #333; color: #eee; border: 1px solid #555; border-radius: 4px; padding: 3px 8px; cursor: pointer; }
      button.stop { background: #8b1c1c; border-color: #b33; }
      .title { font-weight: 600; display: flex; justify-content: space-between; }
      .status { margin-top: 4px; color: #bbb; word-break: break-word; }
      .out { margin-top: 6px; max-height: 220px; overflow: auto; white-space: pre-wrap; color: #ccc; display: none; }
      .cand { cursor: pointer; padding: 2px 0; border-bottom: 1px solid #333; }
      .cand:hover { color: #fff; }
      select { font: inherit; background: #222; color: #eee; border: 1px solid #555; }
    </style>
    <div class="box">
      <div class="title"><span>Venice Bridge</span><span class="conn">○</span></div>
      <div class="status">memuat…</div>
      <div class="row">
        <button class="stop">Stop</button>
        <button class="retry" style="display:none">Coba lagi</button>
        <button class="test">Tes selector</button>
        <select class="key">${KEYS.map((k) => `<option>${k}</option>`).join('')}</select>
        <button class="pick">Kalibrasi</button>
        <button class="hide">_</button>
      </div>
      <div class="out"></div>
    </div>`;
  const $ = (s) => root.querySelector(s);
  const out = $('.out');
  const setStatus = (t) => ($('.status').textContent = t);
  const setConn = (ok) => {
    $('.conn').textContent = ok ? '●' : '○';
    $('.conn').style.color = ok ? '#4c4' : '#c44';
  };
  const show = (html) => {
    out.style.display = 'block';
    out.innerHTML = html;
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  $('.stop').onclick = () => {
    driver.cancelled = true;
    port?.postMessage({ type: 'stop' });
    setStatus('Stop dikirim ke daemon.');
  };
  $('.retry').onclick = () => {
    noReconnect = false;
    $('.retry').style.display = 'none';
    setStatus('Mencoba menyambung lagi…');
    connect();
  };
  $('.hide').onclick = () => {
    out.style.display = 'none';
  };
  $('.test').onclick = () => {
    const r = driver.test();
    show(esc(Object.entries(r).map(([k, v]) => (typeof v === 'object' ? `${k}: ${v.visible}/${v.total} terlihat` : `${k}: ${v}`)).join('\n')));
  };
  $('.pick').onclick = () => {
    const key = $('.key').value;
    setStatus(`Klik elemen untuk "${key}" di halaman…`);
    const onClick = (ev) => {
      if (ev.composedPath().includes(host)) return;
      ev.preventDefault();
      ev.stopPropagation();
      document.removeEventListener('click', onClick, true);
      const list = globalThis.vbSelectorCandidates(ev.target);
      if (!list.length) return setStatus('Tidak ada kandidat selector untuk elemen itu.');
      show(
        `Pilih selector untuk <b>${esc(key)}</b> (angka = jumlah elemen cocok):\n` +
          list.map((c, i) => `<div class="cand" data-i="${i}">${esc(c.selector)}  [${c.matches}]</div>`).join(''),
      );
      out.querySelectorAll('.cand').forEach((d) => {
        d.onclick = async () => {
          const chosen = list[Number(d.dataset.i)].selector;
          const { selectors: saved } = await chrome.storage.local.get({ selectors: {} });
          saved[key] = chosen;
          await chrome.storage.local.set({ selectors: saved });
          await loadSelectors();
          setStatus(`${key} = ${chosen}`);
          out.style.display = 'none';
        };
      });
      setStatus('Pilih salah satu kandidat.');
    };
    document.addEventListener('click', onClick, true);
  };
  document.documentElement.appendChild(host);

  // ---------- link to the background worker ----------
  async function handle(msg) {
    if (msg.type === 'status') return setStatus(msg.text);
    if (msg.type === 'conn') return setConn(msg.ok);
    if (msg.type === 'rejected') {
      // Another tab owns the bridge. Stop auto-reconnecting (no 1s loop); the user can
      // press "Coba lagi" after closing the other tab.
      noReconnect = true;
      setConn(false);
      $('.retry').style.display = '';
      return setStatus(msg.text);
    }
    if (msg.type === 'cancel') {
      driver.cancelled = true;
      return;
    }
    if (msg.type !== 'send') return;
    if (busy) return port?.postMessage({ type: 'reply', id: msg.id, ok: false, error: 'tab sedang memproses pesan lain' });
    busy = true;
    setStatus(`mengirim pesan #${msg.id} (${msg.text.length} karakter)…`);
    try {
      const r = await driver.ask(msg.text, { newChat: msg.newChat, modelPattern: msg.modelPattern });
      port?.postMessage({ type: 'reply', id: msg.id, ok: true, text: r.text, model: r.model });
      setStatus(
        r.sawStopButton
          ? `balasan #${msg.id} diterima (${r.text.length} karakter)`
          : `balasan #${msg.id} diterima, TAPI tombol stop tidak pernah terlihat — kalibrasi "stopButton" agar balasan tidak terpotong`,
      );
    } catch (err) {
      port?.postMessage({ type: 'reply', id: msg.id, ok: false, error: err.message });
      setStatus(`gagal: ${err.message}`);
    } finally {
      busy = false;
      if (reloadQueued) {
        reloadQueued = false;
        loadSelectors();
      }
    }
  }

  function connect() {
    try {
      port = chrome.runtime.connect({ name: 'venice-bridge' });
    } catch {
      return; // extension reloaded; this content script is orphaned
    }
    port.onMessage.addListener(handle);
    port.onDisconnect.addListener(() => {
      port = null;
      setConn(false);
      if (!noReconnect) setTimeout(connect, 1000);
    });
  }

  setInterval(() => port?.postMessage({ type: 'keepalive' }), 25000);
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.selectors) loadSelectors();
  });
  // If the tab is navigating away mid-job, tell the daemon so it does not wait in vain.
  window.addEventListener('pagehide', () => {
    if (busy) {
      try {
        port?.postMessage({ type: 'reply', id: 0, ok: false, error: 'tab ditutup' });
      } catch { /* ignore */ }
    }
  });
  loadSelectors().then(() => {
    setStatus('menghubungkan ke daemon…');
    connect();
  });
})();
