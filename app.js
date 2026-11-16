// app.js - the whole app runs in the browser: language packs, text translation, PDF translation.
import {
  paragraphsFromItems,
  sentencesToTranslate,
  sentencesOf,
  assembleTranslation,
  makeAnalyzer,
  planInline,
  planPanel,
} from "./layout.js";
import { buildPdf } from "./pdfwriter.js";
import { LANGS, LANG_ORDER, packsNeeded, pairsForPack } from "./langs.js";

const PDFJS_VERSION = "4.5.136";
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}`;
const FONT_STACK =
  '"Segoe UI", Tahoma, "Noto Naskh Arabic", "Noto Sans Arabic", "Geeza Pro", "Arabic Typesetting", Arial, sans-serif';
const CDN_CACHE = "mtranslate-cdn-v1";
const PACK_CODES = LANG_ORDER.filter((c) => c !== "en");

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ small helpers

function setStatus(text, kind) {
  const el = $("status");
  el.textContent = text;
  el.className = "chip " + (kind || "");
}

let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 6000);
}

const THEME_LABEL = { auto: "المظهر: تلقائي", dark: "المظهر: داكن", light: "المظهر: فاتح" };
function applyTheme(t) {
  const root = document.documentElement;
  if (t === "light" || t === "dark") root.setAttribute("data-theme", t);
  else root.removeAttribute("data-theme");
  $("theme").textContent = THEME_LABEL[t] || THEME_LABEL.auto;
}

function fmtMB(bytes) {
  return (bytes / 1048576).toFixed(0) + " MB";
}

function getJSON(key, def) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v === null || v === undefined ? def : v;
  } catch (e) {
    return def;
  }
}

// ------------------------------------------------------------------ translation cache (IndexedDB)

let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open("mtranslate-cache", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("t");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}

async function cacheGetMany(keys) {
  const out = new Map();
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx = db.transaction("t", "readonly");
      const store = tx.objectStore("t");
      for (const k of keys) {
        const req = store.get(k);
        req.onsuccess = () => {
          if (req.result) out.set(k, req.result);
        };
      }
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
    });
  } catch (e) {
    /* no cache available: just translate again */
  }
  return out;
}

async function cachePutMany(entries) {
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx = db.transaction("t", "readwrite");
      const store = tx.objectStore("t");
      for (const [k, v] of entries) store.put(v, k);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
    });
  } catch (e) {
    /* ignore */
  }
}

// ------------------------------------------------------------------ translation worker

let worker = null;
let reqId = 0;
const pending = new Map();
const fileProgress = new Map();

function onModelProgress(p) {
  if (!p || !p.file || !p.model) return;
  const key = p.model + "|" + p.file;
  if (p.status === "progress" && p.total) fileProgress.set(key, { loaded: p.loaded || 0, total: p.total });
  if (p.status === "done" && fileProgress.has(key)) {
    const f = fileProgress.get(key);
    fileProgress.set(key, { loaded: f.total, total: f.total });
  }
  let loaded = 0;
  let total = 0;
  for (const [k, f] of fileProgress) {
    if (!k.startsWith(p.model + "|")) continue;
    loaded += f.loaded;
    total += f.total;
  }
  if (total && loaded < total) {
    setStatus(`تحميل ${p.model}: ${Math.round((loaded / total) * 100)}% (${fmtMB(loaded)} من ${fmtMB(total)})`, "busy");
  }
}

function failAll(message) {
  for (const p of pending.values()) p.reject(new Error(message));
  pending.clear();
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker("./worker.js", { type: "module" });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "progress") return onModelProgress(m.p);
    const p = pending.get(m.id);
    if (!p) return;
    if (m.type === "tick") return p.onTick && p.onTick(m.done, m.total);
    pending.delete(m.id);
    if (m.type === "error") p.reject(new Error(m.error));
    else p.resolve(m.type === "result" ? m.out : true);
  };
  worker.onerror = () => {
    worker = null;
    failAll("تعذر تشغيل محرك الترجمة. وصّل النت مرة واحدة وجرّب تاني.");
  };
  return worker;
}

function callWorker(msg, onTick) {
  return new Promise((resolve, reject) => {
    const id = ++reqId;
    pending.set(id, { resolve, reject, onTick });
    getWorker().postMessage({ ...msg, id });
  });
}

// sentences -> Map(sentence -> translation or null)
async function translateSentences(from, to, list, onTick) {
  const result = new Map();
  const keyOf = (s) => `${from}>${to}|${s}`;
  const cached = await cacheGetMany(list.map(keyOf));
  const todo = [];
  for (const s of list) {
    const hit = cached.get(keyOf(s));
    if (hit) result.set(s, hit);
    else todo.push(s);
  }
  if (todo.length) {
    const out = await callWorker({ type: "translate", src: from, tgt: to, texts: todo }, onTick);
    const toStore = [];
    todo.forEach((s, i) => {
      result.set(s, out[i]);
      if (out[i]) toStore.push([keyOf(s), out[i]]);
    });
    await cachePutMany(toStore);
  }
  return result;
}

// ------------------------------------------------------------------ pdf.js

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const lib = await import(`${PDFJS_BASE}/build/pdf.min.mjs`);
      // fetch the worker through the page so the service worker can keep a copy for offline use
      const res = await fetch(`${PDFJS_BASE}/build/pdf.worker.min.mjs`);
      const code = await res.text();
      lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      return lib;
    })().catch((e) => {
      pdfjsPromise = null;
      throw e;
    });
  }
  return pdfjsPromise;
}

// ------------------------------------------------------------------ drawing

const measureCtx = document.createElement("canvas").getContext("2d");
function measureFor(px) {
  measureCtx.font = `${px}px ${FONT_STACK}`;
  return (s) => measureCtx.measureText(s).width;
}

// rtl = the translation is Arabic (draw right-aligned); otherwise left-aligned
function composeInline(src, plan, W, H, rtl) {
  const out = document.createElement("canvas");
  out.width = W;
  out.height = plan.totalH;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, out.height);
  ctx.textBaseline = "top";
  ctx.direction = rtl ? "rtl" : "ltr";
  ctx.textAlign = rtl ? "right" : "left";

  let prev = 0;
  let offset = 0;
  for (const cut of plan.cuts) {
    if (cut.y > prev) ctx.drawImage(src, 0, prev, W, cut.y - prev, 0, prev + offset, W, cut.y - prev);
    const gy = cut.y + offset;
    // continue the background / card colours through the new gap
    ctx.drawImage(src, 0, Math.max(0, cut.y - 1), W, 1, 0, gy, W, cut.gap);
    let y = gy + 1;
    ctx.fillStyle = "#1F4E79";
    for (const it of cut.items) {
      ctx.font = `${it.fontPx}px ${FONT_STACK}`;
      for (const line of it.lines) {
        ctx.fillText(line, rtl ? it.x1 : it.x0, y);
        y += it.lineH;
      }
      y += it.fontPx * 0.6;
    }
    offset += cut.gap;
    prev = cut.y;
  }
  if (prev < H) ctx.drawImage(src, 0, prev, W, H - prev, 0, prev + offset, W, H - prev);
  return out;
}

function composePanel(src, plan, W, H, S, srcRtl, tgtRtl) {
  const out = document.createElement("canvas");
  out.width = W;
  out.height = plan.totalH;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, out.height);
  ctx.drawImage(src, 0, 0);
  ctx.fillStyle = "#f0f4ff";
  ctx.fillRect(0, H, W, plan.extra);
  ctx.fillStyle = "#1F4E79";
  ctx.fillRect(0, H, W, Math.max(1, 1.5 * S));
  ctx.textBaseline = "top";
  let y = H + 12 * S;
  for (const it of plan.items) {
    ctx.fillStyle = "#444444";
    ctx.font = `${it.enPx}px ${FONT_STACK}`;
    ctx.direction = srcRtl ? "rtl" : "ltr";
    ctx.textAlign = srcRtl ? "right" : "left";
    for (const line of it.enLines) {
      ctx.fillText(line, srcRtl ? W - plan.margin : plan.margin, y);
      y += it.enPx * 1.35;
    }
    ctx.fillStyle = "#1F4E79";
    ctx.font = `${it.arPx}px ${FONT_STACK}`;
    ctx.direction = tgtRtl ? "rtl" : "ltr";
    ctx.textAlign = tgtRtl ? "right" : "left";
    for (const line of it.arLines) {
      ctx.fillText(line, tgtRtl ? W - plan.margin : plan.margin, y);
      y += it.arPx * 1.4;
    }
    y += 10 * S;
  }
  return out;
}

function toJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) return reject(new Error("تعذر تحويل الصفحة لصورة (الذاكرة ممتلئة؟). جرّب جودة أقل."));
        resolve(new Uint8Array(await blob.arrayBuffer()));
      },
      "image/jpeg",
      quality
    );
  });
}

// ------------------------------------------------------------------ one page

async function processPage(page, opts, onTick) {
  const S = opts.scale;
  const srcRtl = LANGS[opts.from].rtl;
  const tgtRtl = LANGS[opts.to].rtl;
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: S });
  const W = Math.floor(vp.width);
  const H = Math.floor(vp.height);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const sctx = canvas.getContext("2d", { willReadFrequently: true });
  sctx.fillStyle = "#ffffff";
  sctx.fillRect(0, 0, W, H);
  await page.render({ canvasContext: sctx, viewport: vp }).promise;

  const tc = await page.getTextContent();
  const items = [];
  for (const it of tc.items) {
    if (!("str" in it) || !it.str.trim()) continue;
    const tr = it.transform;
    const [x, y] = vp1.convertToViewportPoint(tr[4], tr[5]);
    items.push({ str: it.str, x, y, w: it.width, size: Math.hypot(tr[2], tr[3]) || it.height || 10 });
  }
  const paras = paragraphsFromItems(items, { rtl: srcRtl });

  const needed = new Set();
  for (const p of paras) for (const s of sentencesToTranslate(p.text)) needed.add(s);
  const dict = await translateSentences(opts.from, opts.to, [...needed], onTick);

  const kept = [];
  const translated = [];
  let failed = 0;
  for (const p of paras) {
    const tr = assembleTranslation(p.text, (s) => dict.get(s) || null);
    if (tr) {
      kept.push(p);
      translated.push(tr);
    } else failed++;
  }

  let out = canvas;
  if (kept.length) {
    const common = { W, H, S, paras: kept, arabic: translated, measureFor, arScale: opts.arScale };
    if (opts.mode === "panel") {
      out = composePanel(canvas, planPanel(common), W, H, S, srcRtl, tgtRtl);
    } else {
      const analyzer = makeAnalyzer(sctx.getImageData(0, 0, W, H).data, W, H);
      const plan = planInline({ ...common, analyzer });
      if (plan.totalH > H * 3.5 || W * plan.totalH > 15e6)
        out = composePanel(canvas, planPanel(common), W, H, S, srcRtl, tgtRtl);
      else out = composeInline(canvas, plan, W, H, tgtRtl);
    }
  }

  const jpeg = await toJpeg(out, opts.quality);
  const res = { jpeg, wPx: out.width, hPx: out.height, wPt: out.width / S, hPt: out.height / S, failed };
  if (out !== canvas) out.width = out.height = 0;
  canvas.width = canvas.height = 0;
  return res;
}

// ------------------------------------------------------------------ one file

async function translateFile(file, opts, row) {
  const lib = await loadPdfjs();
  const data = await file.arrayBuffer();
  const pdf = await lib.getDocument({
    data,
    cMapUrl: `${PDFJS_BASE}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_BASE}/standard_fonts/`,
  }).promise;

  const pages = [];
  let failed = 0;
  for (let n = 1; n <= pdf.numPages; n++) {
    row.set(((n - 1) / pdf.numPages) * 100, `صفحة ${n} من ${pdf.numPages}`);
    const page = await pdf.getPage(n);
    const r = await processPage(page, opts, (done, total) =>
      row.set(((n - 1) / pdf.numPages) * 100, `صفحة ${n} من ${pdf.numPages} - ترجمة ${done}/${total}`)
    );
    failed += r.failed;
    pages.push(r);
    page.cleanup();
  }
  await pdf.destroy();
  row.set(100, "جاري تجميع الملف...");
  return { bytes: buildPdf(pages), failed };
}

// ------------------------------------------------------------------ language packs

function installedPacks() {
  return new Set(getJSON("mtranslate_packs_installed", []));
}

function markInstalled(codes) {
  const s = installedPacks();
  codes.forEach((c) => s.add(c));
  localStorage.setItem("mtranslate_packs_installed", JSON.stringify([...s]));
}

let packBoxes = [];
function renderPacks() {
  const box = $("packs");
  box.textContent = "";
  packBoxes = [];
  const inst = installedPacks();
  const sel = new Set(getJSON("mtranslate_packs_selected", ["ar"]));
  for (const code of PACK_CODES) {
    const label = document.createElement("label");
    label.className = "pack";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = code;
    cb.checked = sel.has(code) || !inst.has(code) === false ? sel.has(code) : sel.has(code);
    cb.onchange = () => localStorage.setItem("mtranslate_packs_selected", JSON.stringify(selectedPacks()));
    const span = document.createElement("span");
    span.textContent = LANGS[code].name + (inst.has(code) ? "  ✓ جاهزة" : "");
    label.append(cb, span);
    box.appendChild(label);
    packBoxes.push(cb);
  }
}

function selectedPacks() {
  return packBoxes.filter((b) => b.checked).map((b) => b.value);
}

function refreshStatus() {
  const inst = [...installedPacks()];
  if (!inst.length) {
    setStatus("لسه مفيش حزم لغات متنزلة. اختار حزمة واضغط «تحميل الحزم المختارة».", "warn");
    return;
  }
  const names = inst.map((c) => LANGS[c].name).join("، ");
  setStatus((navigator.onLine ? "جاهز للعمل بدون نت ✓ " : "شغال بدون نت ✓ ") + "(الحزم: " + names + ")", "ok");
}

// before a translation: tell the user if a needed pack is not downloaded (and they are offline)
function checkPacks(from, to) {
  const need = packsNeeded(from, to);
  const inst = installedPacks();
  const missing = need.filter((c) => !inst.has(c));
  if (missing.length && !navigator.onLine) {
    throw new Error("حزمة " + missing.map((c) => LANGS[c].name).join(" و") + " مش متنزلة. وصّل النت ونزّلها الأول.");
  }
  return need;
}

// ------------------------------------------------------------------ install + offline

function isStandalone() {
  return (
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    window.navigator.standalone === true
  );
}

function platform() {
  const ua = navigator.userAgent || "";
  if (/iphone|ipad|ipod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "ios";
  if (/android/i.test(ua)) return "android";
  return "desktop";
}

const INSTALL_HELP = {
  ios: "على الآيفون والآيباد (من Safari): اضغط زرار المشاركة ثم «Add to Home Screen» ثم «Add».",
  android: "على أندرويد (Chrome): اضغط القايمة ⋮ ثم «Install app» أو «Add to Home screen».",
  desktop:
    "على الكمبيوتر (Chrome أو Edge أو Brave): اضغط أيقونة التثبيت في شريط العنوان، أو القايمة ⋮ ثم «Install». على ماك Safari: File ثم «Add to Dock».",
};

function setupInstall() {
  const btn = $("install");
  const help = $("installHelp");
  if (isStandalone()) {
    btn.hidden = true;
    help.hidden = true;
    return;
  }
  btn.hidden = false;
  let deferred = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
  });
  window.addEventListener("appinstalled", () => {
    btn.hidden = true;
    help.hidden = true;
    toast("اتثبّت التطبيق ✓ افتحه من الشاشة الرئيسية.");
  });
  btn.onclick = async () => {
    if (deferred) {
      deferred.prompt();
      const choice = await deferred.userChoice;
      deferred = null;
      if (choice && choice.outcome === "accepted") return;
    }
    help.textContent = INSTALL_HELP[platform()];
    help.hidden = false;
  };
}

async function cdnCacheCount() {
  try {
    if (typeof caches === "undefined") return -1; // cannot check
    const c = await caches.open(CDN_CACHE);
    return (await c.keys()).length;
  } catch (e) {
    return -1;
  }
}

// the service worker must be controlling the page, otherwise the libraries are not saved for offline use
async function ensureControlled() {
  if (!("serviceWorker" in navigator)) return;
  await navigator.serviceWorker.ready;
  if (navigator.serviceWorker.controller) return;
  await new Promise((resolve) => {
    navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
    setTimeout(resolve, 5000);
  });
}

let preparing = false;
async function prepareOffline() {
  if (preparing) return;
  const codes = selectedPacks();
  if (!codes.length) {
    toast("اختار حزمة لغة واحدة على الأقل");
    return;
  }
  localStorage.setItem("mtranslate_packs_selected", JSON.stringify(codes));
  preparing = true;
  const btn = $("prepare");
  btn.disabled = true;
  try {
    if (!navigator.onLine) throw new Error("مفيش نت دلوقتي");
    setStatus("جاري تجهيز التطبيق للعمل بدون نت...", "busy");
    await ensureControlled();
    await loadPdfjs();
    const pairs = codes.flatMap(pairsForPack);
    await callWorker({ type: "init", pairs }, (done, total) => toast(`تم تحميل نموذج ${done} من ${total}`));
    for (const code of codes) {
      const t = await callWorker({ type: "translate", src: "en", tgt: code, texts: ["Hello world."] });
      if (!t[0]) throw new Error(`حزمة ${LANGS[code].name}: النموذج اشتغل بس الترجمة رجعت فاضية`);
    }
    if ((await cdnCacheCount()) === 0)
      throw new Error("الملفات ماتخزنتش للعمل بدون نت. اقفل الصفحة وافتحها تاني وجرّب.");
    markInstalled(codes);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    renderPacks();
    refreshStatus();
  } catch (e) {
    setStatus("فشل التجهيز: " + ((e && e.message) || e), "err");
  } finally {
    preparing = false;
    btn.disabled = false;
  }
}

// ------------------------------------------------------------------ text translation

async function translateTextBox() {
  const from = $("tsrc").value;
  const to = $("ttgt").value;
  const text = $("tin").value.trim();
  const out = $("tout");
  const stat = $("tstat");
  if (!text) {
    toast("اكتب كلمة أو جملة الأول");
    return;
  }
  out.hidden = true;
  $("tcopy").hidden = true;
  stat.className = "st";
  const show = (value) => {
    out.textContent = value;
    out.dir = LANGS[to].rtl ? "rtl" : "ltr";
    out.hidden = false;
    $("tcopy").hidden = false;
  };
  if (from === to) {
    show(text);
    return;
  }
  $("tgo").disabled = true;
  stat.textContent = "جاري الترجمة...";
  try {
    checkPacks(from, to);
    const perLine = text.split(/\n/).map((l) => sentencesOf(l));
    const all = new Set();
    perLine.forEach((ss) => ss.forEach((s) => all.add(s)));
    const dict = await translateSentences(from, to, [...all], (d, t) => {
      stat.textContent = `جاري الترجمة ${d}/${t}`;
    });
    show(perLine.map((ss) => ss.map((s) => dict.get(s) || s).join(" ")).join("\n"));
    stat.textContent = "";
    markInstalled(packsNeeded(from, to));
    renderPacks();
  } catch (e) {
    stat.textContent = "حدث خطأ: " + ((e && e.message) || e);
    stat.className = "st err";
  } finally {
    $("tgo").disabled = false;
  }
}

function swapText() {
  const a = $("tsrc");
  const b = $("ttgt");
  const v = a.value;
  a.value = b.value;
  b.value = v;
  const out = $("tout");
  if (!out.hidden) {
    $("tin").value = out.textContent;
    out.hidden = true;
    $("tcopy").hidden = true;
  }
  saveLangChoices();
}

async function copyOutput() {
  try {
    await navigator.clipboard.writeText($("tout").textContent);
    toast("اتنسخت الترجمة ✓");
  } catch (e) {
    toast("مقدرتش أنسخ. حدد النص وانسخه بإيدك.");
  }
}

// ------------------------------------------------------------------ PDF jobs UI

function makeRow(name) {
  const card = document.createElement("div");
  card.className = "card job";
  const n = document.createElement("div");
  n.className = "name";
  n.textContent = name;
  const bar = document.createElement("div");
  bar.className = "bar";
  const fill = document.createElement("i");
  bar.appendChild(fill);
  const st = document.createElement("div");
  st.className = "st";
  st.textContent = "في الانتظار...";
  card.append(n, bar, st);
  $("jobs").prepend(card);
  return {
    card,
    set(pct, text) {
      fill.style.width = Math.max(0, Math.min(100, pct)) + "%";
      st.textContent = text;
      st.className = "st";
    },
    fail(text) {
      st.textContent = text;
      st.className = "st err";
    },
    done(blob, outName, failed) {
      fill.style.width = "100%";
      st.textContent = "تمت الترجمة" + (failed ? ` (${failed} فقرة معرفتش أترجمها)` : "");
      const a = document.createElement("a");
      a.className = "btn ok";
      a.href = URL.createObjectURL(blob);
      a.download = outName;
      a.textContent = "تحميل الملف المترجم";
      card.appendChild(a);
      const file = new File([blob], outName, { type: "application/pdf" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        const b = document.createElement("button");
        b.className = "alt";
        b.textContent = "مشاركة";
        b.onclick = () => navigator.share({ files: [file] }).catch(() => {});
        card.appendChild(b);
      }
    },
  };
}

let chain = Promise.resolve();

function startTranslation() {
  const files = Array.from($("files").files);
  if (!files.length) {
    alert("اختار ملف PDF الأول");
    return;
  }
  const from = $("fsrc").value;
  const to = $("ftgt").value;
  if (from === to) {
    toast("لغة الملف والترجمة نفس اللغة. غيّر واحدة منهم.");
    return;
  }
  try {
    checkPacks(from, to);
  } catch (e) {
    toast(e.message);
    return;
  }
  const opts = {
    from,
    to,
    mode: $("mode").value,
    arScale: parseFloat($("size").value),
    scale: parseFloat($("quality").value),
    quality: 0.85,
  };
  $("files").value = "";
  for (const file of files) {
    const row = makeRow(file.name);
    chain = chain.then(async () => {
      try {
        row.set(0, "بدأت...");
        const { bytes, failed } = await translateFile(file, opts, row);
        const outName = file.name.replace(/\.pdf$/i, "") + " " + to + ".pdf";
        row.done(new Blob([bytes], { type: "application/pdf" }), outName, failed);
        markInstalled(packsNeeded(from, to));
        renderPacks();
      } catch (e) {
        row.fail("حدث خطأ: " + ((e && e.message) || e));
      }
    });
  }
}

// ------------------------------------------------------------------ start

function fillLangSelect(el, value) {
  el.textContent = "";
  for (const code of LANG_ORDER) {
    const o = document.createElement("option");
    o.value = code;
    o.textContent = LANGS[code].name;
    el.appendChild(o);
  }
  el.value = value;
  el.onchange = saveLangChoices;
}

function saveLangChoices() {
  localStorage.setItem(
    "mtranslate_langs",
    JSON.stringify({ tsrc: $("tsrc").value, ttgt: $("ttgt").value, fsrc: $("fsrc").value, ftgt: $("ftgt").value })
  );
}

async function init() {
  const saved = getJSON("mtranslate_langs", {});
  fillLangSelect($("tsrc"), saved.tsrc || "en");
  fillLangSelect($("ttgt"), saved.ttgt || "ar");
  fillLangSelect($("fsrc"), saved.fsrc || "en");
  fillLangSelect($("ftgt"), saved.ftgt || "ar");
  renderPacks();

  $("go").onclick = startTranslation;
  $("prepare").onclick = prepareOffline;
  $("tgo").onclick = translateTextBox;
  $("tswap").onclick = swapText;
  $("tcopy").onclick = copyOutput;

  let theme = localStorage.getItem("mtranslate_theme") || "auto";
  applyTheme(theme);
  $("theme").onclick = () => {
    theme = theme === "auto" ? "dark" : theme === "dark" ? "light" : "auto";
    localStorage.setItem("mtranslate_theme", theme);
    applyTheme(theme);
  };

  // app mode: works offline, keeps its data, updates itself
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register("./sw.js")
      .then((reg) => setInterval(() => reg.update().catch(() => {}), 3600000))
      .catch(() => {});
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data === "updated") toast("في نسخة جديدة جاهزة. اقفل التطبيق وافتحه تاني.");
    });
  }
  window.addEventListener("online", () => {
    toast("رجع النت.");
    refreshStatus();
  });
  window.addEventListener("offline", () => {
    toast("النت قاطع. التطبيق هيكمل شغل عادي للحزم الجاهزة.");
    refreshStatus();
  });

  setupInstall();

  // a missing saved-files cache means the browser cleaned our storage: ask for the download again
  if (installedPacks().size && (await cdnCacheCount()) === 0) localStorage.removeItem("mtranslate_packs_installed");
  renderPacks();
  refreshStatus();
}

init();
