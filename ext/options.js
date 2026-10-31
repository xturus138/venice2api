const $ = (id) => document.getElementById(id);
const say = (t, ok = true) => {
  $('msg').textContent = t;
  $('msg').style.color = ok ? '#070' : '#b00';
};

async function load() {
  const s = await chrome.storage.local.get({ port: 8765, token: '', selectors: {}, trustedInput: false, typeDelayMs: 35, typeJitter: 0.5 });
  $('port').value = s.port;
  $('token').value = s.token;
  $('trustedInput').checked = !!s.trustedInput;
  $('typeDelayMs').value = s.typeDelayMs;
  $('typeJitter').value = s.typeJitter;
  $('selectors').value = JSON.stringify({ ...globalThis.VB_DEFAULT_SELECTORS, ...s.selectors }, null, 2);
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

$('save').onclick = async () => {
  let parsed;
  try {
    parsed = JSON.parse($('selectors').value);
  } catch (e) {
    return say(`JSON selector tidak valid: ${e.message}`, false);
  }
  const custom = {};
  const invalid = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== 'string' || !v.trim()) continue;
    try {
      document.querySelector(v); // throws on invalid CSS syntax
    } catch {
      invalid.push(k);
      continue;
    }
    if (v !== globalThis.VB_DEFAULT_SELECTORS[k]) custom[k] = v.trim();
  }
  if (invalid.length) return say(`Selector tidak valid (sintaks CSS): ${invalid.join(', ')}`, false);
  await chrome.storage.local.set({
    port: Number($('port').value) || 8765,
    token: $('token').value.trim(),
    selectors: custom,
    trustedInput: $('trustedInput').checked,
    typeDelayMs: Math.max(0, Number($('typeDelayMs').value) || 35),
    typeJitter: clamp(Number($('typeJitter').value) || 0, 0, 0.9),
  });
  say('Tersimpan.');
};

$('reset').onclick = async () => {
  await chrome.storage.local.set({ selectors: {} });
  await load();
  say('Selector dikembalikan ke default.');
};

load();
