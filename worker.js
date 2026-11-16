// worker.js - runs the translation models inside the browser (no server needed).
// Models are downloaded once and kept in the browser cache, so they work offline afterwards.
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6";
import { stepsFor, modelFor, prefixFor } from "./langs.js";

env.allowLocalModels = false;
env.useBrowserCache = true;

const HAS_AR = /[\u0600-\u06FF]/;
const HAS_LETTER = /\p{L}/u;
const MAX_LOADED = 2; // keep memory low on phones

const loaded = new Map(); // "src-tgt" -> translator (oldest first)
const loading = new Map();

function post(msg) {
  self.postMessage(msg);
}

async function evict() {
  while (loaded.size > MAX_LOADED) {
    const [key, t] = loaded.entries().next().value;
    loaded.delete(key);
    try {
      if (t && t.dispose) await t.dispose();
    } catch (e) {
      /* ignore */
    }
  }
}

function getTranslator(src, tgt) {
  const key = `${src}-${tgt}`;
  if (loaded.has(key)) {
    const t = loaded.get(key);
    loaded.delete(key);
    loaded.set(key, t); // mark as recently used
    return Promise.resolve(t);
  }
  if (loading.has(key)) return loading.get(key);
  const p = pipeline("translation", modelFor(src, tgt), {
    dtype: "q8",
    progress_callback: (info) => post({ type: "progress", p: { ...info, model: key } }),
  }).then(
    async (t) => {
      loading.delete(key);
      loaded.set(key, t);
      await evict();
      return t;
    },
    (err) => {
      loading.delete(key);
      throw err;
    }
  );
  loading.set(key, p);
  return p;
}

async function runStep(src, tgt, texts, onItem) {
  const t = await getTranslator(src, tgt);
  const prefix = prefixFor(src, tgt);
  const out = [];
  for (let i = 0; i < texts.length; i++) {
    let res = null;
    if (texts[i] && HAS_LETTER.test(texts[i])) {
      try {
        const r = await t(prefix + texts[i], { max_new_tokens: 256 });
        const s = ((r && r[0] && r[0].translation_text) || "").replace(/^\s*>>\w+<<\s*/, "").trim();
        if (s && (tgt !== "ar" || HAS_AR.test(s))) res = s;
      } catch (err) {
        res = null;
      }
    }
    out.push(res);
    onItem(i + 1, texts.length);
  }
  return out;
}

let queue = Promise.resolve();
self.onmessage = (e) => {
  const msg = e.data;
  queue = queue
    .then(() => handle(msg))
    .catch((err) => post({ type: "error", id: msg.id, error: String((err && err.message) || err) }));
};

async function handle(msg) {
  if (msg.type === "init") {
    // download + cache the models of the chosen language packs
    for (let i = 0; i < msg.pairs.length; i++) {
      await getTranslator(msg.pairs[i][0], msg.pairs[i][1]);
      post({ type: "tick", id: msg.id, done: i + 1, total: msg.pairs.length });
    }
    post({ type: "ready", id: msg.id });
    return;
  }
  if (msg.type === "translate") {
    const steps = stepsFor(msg.src, msg.tgt);
    let cur = msg.texts.slice();
    const total = msg.texts.length;
    for (let s = 0; s < steps.length; s++) {
      const [a, b] = steps[s];
      cur = await runStep(a, b, cur, (done) => {
        if (done % 3 === 0 || done === total) post({ type: "tick", id: msg.id, done, total });
      });
    }
    post({ type: "result", id: msg.id, out: cur });
  }
}
