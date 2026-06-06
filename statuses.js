"use strict";

const OA_BASE = "https://ogladajanime.pl";
const AZ_BASE = "https://www.animezone.pl";
const ICONS = {
  arrow: "assets/arrow-right.svg",
  check: "assets/check.svg",
  exclamation: "assets/exclamation.svg",
  question: "assets/question.svg",
  equals: "assets/equals.svg",
  oa: "assets/oa.png",
  az: "assets/az.svg",
};

const OA_STATUS = {
  1: "Oglądam",
  2: "Obejrzane",
  3: "Planuję",
  4: "Wstrzymane",
  5: "Porzucone",
};
const OA_STATUS_CODES = [1, 2, 3, 4, 5];

const AZ_STATUS = { watching: "Oglądam", plans: "Planuję" };
const AZ_SET_CODE = { watching: 1, plans: 3 };

const DEFAULT_MAPPING = { 1: "watching", 2: "watching", 3: "plans", 4: "watching", 5: "watching" };
const MAPPING_KEY = "oaAzStatusMapping";
const TARGET_OPTIONS = [
  { value: "watching", label: "Oglądam" },
  { value: "plans", label: "Planuję" },
  { value: "skip", label: "Pomiń" },
];

function loadMapping() {
  const map = { ...DEFAULT_MAPPING };
  try {
    const saved = JSON.parse(localStorage.getItem(MAPPING_KEY) || "{}");
    for (const code of OA_STATUS_CODES) {
      const v = saved[code];
      if (v === "watching" || v === "plans" || v === "skip") map[code] = v;
    }
  } catch (e) {
    console.warn("Nie udało się wczytać mapowania:", e);
  }
  return map;
}

let statusMapping = loadMapping();

function targetForOa(code) {
  return statusMapping[code] || "watching";
}

const els = {
  oaProfile: document.getElementById("oaProfile"),
  azProfile: document.getElementById("azProfile"),
  status: document.getElementById("status"),
  authNotice: document.getElementById("authNotice"),
  authText: document.getElementById("authText"),
  summaryCards: document.getElementById("summaryCards"),
  progressCard: document.getElementById("progressCard"),
  progressPercent: document.getElementById("progressPercent"),
  progressFill: document.getElementById("progressFill"),
  filters: document.getElementById("filters"),
  results: document.getElementById("results"),
  migrationBar: document.getElementById("migrationBar"),
  migrationTitle: document.getElementById("migrationTitle"),
  migrationMeta: document.getElementById("migrationMeta"),
  migrateBtn: document.getElementById("migrateBtn"),
  settingsBtn: document.getElementById("settingsBtn"),
  settingsModal: document.getElementById("settingsModal"),
  settingsClose: document.getElementById("settingsClose"),
  settingsCancel: document.getElementById("settingsCancel"),
  settingsSave: document.getElementById("settingsSave"),
  settingsReset: document.getElementById("settingsReset"),
  settingsRows: document.getElementById("settingsRows"),
};

let master = [];
let oaStatusBySlug = new Map();
let azStatusBySlug = new Map();
let oaId = null;
let oaUser = null;
let azUser = null;
let currentFilter = "all";
let loading = false;
let loaded = false;
let migrationRunning = false;

const filterLabels = {
  all: "Wszystkie",
  transfer: "Do przeniesienia",
  match: "Zgodne",
  conflict: "Konflikty",
  unmatched: "Bez dopasowania",
};

function slugFromUrl(url) {
  const m = /\/anime\/([^/?#]+)/.exec(url || "");
  return m ? m[1] : null;
}

function makeEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

// Odstęp między kolejnymi żądaniami do AZ, żeby nie zalewać serwera.
const THROTTLE_MS = 300;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function bgFetch(url, credentials = "omit") {
  const res = await browser.runtime.sendMessage({ type: "fetch", url, credentials });
  if (!res) throw new Error("brak odpowiedzi ze skryptu tła");
  if (res.error) throw new Error(res.error);
  return res;
}

function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle("error", isError);
}

function showAuthNotice(services) {
  els.authText.replaceChildren("Zaloguj się na ");
  services.forEach((svc, i) => {
    if (i > 0) els.authText.append(i === services.length - 1 ? " i " : ", ");
    const link = makeEl("a", "auth-link", svc.label);
    link.href = svc.href;
    link.target = "_blank";
    link.rel = "noopener";
    els.authText.append(link);
  });
  els.authText.append(" — spróbuję ponownie, gdy wrócisz na tę kartę.");

  setStatus("");
  els.authNotice.hidden = false;
}

function hideAuthNotice() {
  els.authNotice.hidden = true;
}

function setProfiles(oaOk = false, azOk = false) {
  els.oaProfile.textContent = oaOk ? (oaUser || "wykryto konto") : "niezalogowany";
  els.azProfile.textContent = azOk ? azUser : "niezalogowany";
}

function hideDataViews() {
  els.summaryCards.hidden = true;
  els.progressCard.hidden = true;
  els.filters.hidden = true;
  els.results.hidden = true;
  els.migrationBar.hidden = true;
}

function coverUrl(scope, base) {
  const img = scope && scope.querySelector("img");
  if (!img) return "";
  const src =
    img.getAttribute("src") ||
    img.getAttribute("data-src") ||
    img.getAttribute("data-original") ||
    img.getAttribute("data-lazy") ||
    "";
  if (!src || src.startsWith("data:")) return "";
  if (src.startsWith("//")) return `https:${src}`;
  if (src.startsWith("/")) return `${base}${src}`;
  return src;
}

async function loadMaster() {
  const resp = await fetch("data.ndjson");
  const text = await resp.text();
  master = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    const oaSlug = slugFromUrl(rec.oa_url);
    const azSlug = slugFromUrl(rec.az_url);
    master.push({
      malId: rec.mal_id,
      malUrl: rec.mal_url,
      oaTitle: rec.oa_title || oaSlug || "Bez dopasowania",
      azTitle: rec.az_title || azSlug || "",
      oaSlug,
      azSlug,
    });
  }
}

async function detectOaId() {
  const resp = await bgFetch(`${OA_BASE}/`, "include");
  if (!resp.ok) throw new Error(`OA HTTP ${resp.status}`);
  const m =
    /active_sessions'[^)]*\{id:\s*(\d+)\}/.exec(resp.text) ||
    /\/profile\/(\d+)/.exec(resp.text);
  if (!m) throw new Error("nie wykryto zalogowanego konta OA (zaloguj się)");
  return m[1];
}

function parseOaUserName(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const title = doc.querySelector("h4.card-title");
  const text = title ? title.textContent.replace(/\s+/g, " ").trim() : "";
  const m = /^(.+?)\s+-\s+Profil$/i.exec(text);
  return m ? m[1].trim() : null;
}

async function detectOaUserName(id) {
  const resp = await bgFetch(`${OA_BASE}/profile/${encodeURIComponent(id)}`, "omit");
  if (!resp.ok) throw new Error(`OA profil HTTP ${resp.status}`);
  return parseOaUserName(resp.text);
}

async function loadOaStatuses() {
  oaStatusBySlug = new Map();
  oaUser = null;
  oaId = await detectOaId();
  try {
    oaUser = await detectOaUserName(oaId);
  } catch (err) {
    console.warn("Nie udało się pobrać nicku OA:", err);
  }
  for (let idx = 0; idx < OA_STATUS_CODES.length; idx += 1) {
    const code = OA_STATUS_CODES[idx];
    if (idx > 0) await sleep(THROTTLE_MS);
    const resp = await bgFetch(`${OA_BASE}/anime_list/${oaId}/${code}`, "omit");
    if (!resp.ok) throw new Error(`OA HTTP ${resp.status}`);
    const doc = new DOMParser().parseFromString(resp.text, "text/html");
    for (const tr of doc.querySelectorAll('tr[id^="anime_list_item_"]')) {
      const cells = tr.querySelectorAll(":scope > td");
      const link = cells[2] && cells[2].querySelector('a[href^="/anime/"]');
      if (!link) continue;
      const slug = slugFromUrl(link.getAttribute("href"));
      if (!slug) continue;
      oaStatusBySlug.set(slug, {
        code,
        cover: coverUrl(tr, OA_BASE),
        title: link.textContent.trim(),
      });
    }
  }
}

async function detectAzUser() {
  const resp = await bgFetch(`${AZ_BASE}/`, "include");
  if (!resp.ok) throw new Error(`AZ HTTP ${resp.status}`);
  for (const m of resp.text.matchAll(/\/user\/([A-Za-z0-9_-]+)"/g)) {
    if (m[1] !== "edit") return m[1];
  }
  throw new Error("nie wykryto zalogowanego użytkownika AZ (zaloguj się)");
}

async function loadAzStatuses() {
  azStatusBySlug = new Map();
  azUser = await detectAzUser();
  const lists = [
    { key: "watching", path: "watching" },
    { key: "plans", path: "plans" },
  ];
  for (let idx = 0; idx < lists.length; idx += 1) {
    const { key, path } = lists[idx];
    if (idx > 0) await sleep(THROTTLE_MS);
    const resp = await bgFetch(
      `${AZ_BASE}/user/${encodeURIComponent(azUser)}/${path}`,
      "include",
    );
    if (!resp.ok) throw new Error(`AZ HTTP ${resp.status}`);
    const doc = new DOMParser().parseFromString(resp.text, "text/html");
    for (const block of doc.querySelectorAll(".well.categories")) {
      const link = block.querySelector('a[href^="/anime/"]');
      if (!link) continue;
      const slug = slugFromUrl(link.getAttribute("href"));
      if (slug) azStatusBySlug.set(slug, key);
    }
  }
}

function rowsToShow() {
  const priority = { transfer: 0, conflict: 1, match: 2, unmatched: 3 };
  const masterByOa = new Map();
  const masterByAz = new Map();
  for (const m of master) {
    if (m.oaSlug) masterByOa.set(m.oaSlug, m);
    if (m.azSlug) masterByAz.set(m.azSlug, m);
  }

  const rows = [];
  const coveredAz = new Set();

  for (const [oaSlug, oa] of oaStatusBySlug) {
    const m = masterByOa.get(oaSlug);
    const azSlug = m ? m.azSlug : null;
    const target = targetForOa(oa.code);
    if (target === "skip") {
      if (azSlug) coveredAz.add(azSlug);
      continue;
    }
    const azStatus = azSlug ? azStatusBySlug.get(azSlug) || "" : "";
    const row = {
      oaSlug,
      azSlug,
      oaTitle: (m && m.oaTitle) || oa.title || oaSlug,
      azTitle: (m && m.azTitle) || "",
      oaCode: oa.code,
      oaStatusLabel: OA_STATUS[oa.code] || "",
      oaCover: oa.cover,
      azStatus,
      azStatusLabel: azStatus ? AZ_STATUS[azStatus] : "",
      target,
      targetLabel: AZ_STATUS[target],
    };
    if (!azSlug) {
      row.kind = "unmatched";
      row.missing = "az";
    } else {
      coveredAz.add(azSlug);
      row.kind = !azStatus
        ? "transfer"
        : azStatus === target
          ? "match"
          : "conflict";
    }
    rows.push(row);
  }

  for (const [azSlug, azStatus] of azStatusBySlug) {
    if (coveredAz.has(azSlug)) continue;
    const m = masterByAz.get(azSlug);
    rows.push({
      oaSlug: m ? m.oaSlug : null,
      azSlug,
      oaTitle: (m && m.oaTitle) || "",
      azTitle: (m && m.azTitle) || azSlug,
      oaCode: 0,
      oaStatusLabel: "",
      oaCover: "",
      azStatus,
      azStatusLabel: AZ_STATUS[azStatus],
      target: "",
      targetLabel: "",
      kind: "unmatched",
      missing: "oa",
    });
  }

  const rank = (row) =>
    row.kind === "unmatched" && row.missing === "oa" ? 4 : priority[row.kind];
  return rows.sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const an = a.azTitle || a.oaTitle;
    const bn = b.azTitle || b.oaTitle;
    return String(an).localeCompare(String(bn), "pl");
  });
}

function computeCounts(rows) {
  const counts = { all: rows.length, transfer: 0, match: 0, conflict: 0, unmatched: 0 };
  rows.forEach((row) => {
    if (counts[row.kind] !== undefined) counts[row.kind] += 1;
  });
  return counts;
}

function pct(part, total) {
  return total > 0 ? ((part / total) * 100).toFixed(1) : "0.0";
}

function formatCount(count, one, few, many) {
  if (count === 1) return one;
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) {
    return few;
  }
  return many;
}

function updateSummary(rows, counts) {
  const relevant = counts.transfer + counts.match + counts.conflict;
  const progress = relevant > 0 ? Math.round((counts.match / relevant) * 100) : 0;

  const cards = [
    {
      tone: "blue",
      iconSrc: ICONS.arrow,
      label: "Do przeniesienia",
      value: counts.transfer,
      meta: `${pct(counts.transfer, relevant)}%`,
    },
    {
      tone: "orange",
      iconSrc: ICONS.exclamation,
      label: "Konfliktów",
      value: counts.conflict,
      meta: `${pct(counts.conflict, relevant)}%`,
    },
    {
      tone: "green",
      iconSrc: ICONS.check,
      label: "Zgodnych",
      value: counts.match,
      meta: `${pct(counts.match, relevant)}%`,
    },
    {
      tone: "muted",
      iconSrc: ICONS.question,
      label: "Bez dopasowania",
      value: counts.unmatched,
      meta: "",
    },
  ];

  els.summaryCards.replaceChildren(
    ...cards.map((card) => {
      const wrap = makeEl("article", `summary-card ${card.tone}`);
      const icon = makeEl("span", "summary-icon");
      if (card.iconSrc) {
        const img = makeEl("img");
        img.src = card.iconSrc;
        img.alt = "";
        icon.append(img);
      }
      wrap.append(icon);
      const body = makeEl("div");
      body.append(
        makeEl("p", "eyebrow", card.label),
        makeEl("strong", "", String(card.value)),
        makeEl("p", "", card.meta || " "),
      );
      wrap.append(body);
      return wrap;
    }),
  );

  els.progressPercent.textContent = `${progress}%`;
  els.progressFill.style.width = `${progress}%`;

  els.summaryCards.hidden = false;
  els.progressCard.hidden = false;

  for (const btn of els.filters.querySelectorAll(".filter-btn")) {
    const filter = btn.dataset.filter;
    const count = counts[filter] || 0;
    const countEl = btn.querySelector("strong");
    btn.classList.toggle("active", filter === currentFilter);
    if (countEl) countEl.textContent = String(count);
  }

  const transferable = rows.filter((row) => row.kind === "transfer").length;
  els.migrationTitle.textContent = transferable
    ? `${transferable} ${formatCount(
        transferable,
        "status zostanie ustawiony",
        "statusy zostaną ustawione",
        "statusów zostanie ustawionych",
      )}`
    : "Brak statusów do automatycznego ustawienia";
  els.migrationMeta.textContent =
    "Statusy migrowane wg mapowania (ikona ⚙ przy zakładce). Konflikty wymagają decyzji.";
  els.migrateBtn.disabled = transferable === 0 || migrationRunning;
}

function makeTitleLine(iconSrc, iconAlt, base, slug, text) {
  const line = makeEl("div", "title-line");
  const icon = makeEl("img", "title-icon");
  icon.src = iconSrc;
  icon.alt = iconAlt;
  line.append(icon);
  if (slug) {
    const link = makeEl("a", "", text || slug);
    link.href = `${base}/anime/${slug}`;
    link.target = "_blank";
    link.rel = "noopener";
    line.append(link);
  } else {
    line.append(makeEl("span", "", text || "Brak dopasowania"));
  }
  return line;
}

function makeStatusCell(source, label) {
  const cell = makeEl("div", "rating-cell");
  cell.append(makeEl("p", "rating-source", source));
  const value = makeEl("div", `rating-value status-text${label ? "" : " empty"}`);
  value.textContent = label || "—";
  cell.append(value);
  return cell;
}

function makeStateCell(row) {
  const config = {
    transfer: { iconSrc: ICONS.arrow, label: "Do przeniesienia" },
    conflict: { iconSrc: ICONS.exclamation, label: "Konflikt" },
    match: { iconSrc: ICONS.check, label: "Zgodne" },
    unmatched: { iconSrc: ICONS.question, label: "Bez dopasowania" },
  }[row.kind];
  const cell = makeEl("div", `state-cell ${row.kind}`);
  cell.title = config.label;
  const icon = makeEl("span", "state-icon");
  const img = makeEl("img");
  img.src = config.iconSrc;
  img.alt = "";
  icon.append(img);
  cell.append(icon);
  return cell;
}

function makeRelationCell(row) {
  const cell = makeEl("div", `relation-cell ${row.kind}`);
  if (row.kind === "transfer") {
    const img = makeEl("img", "relation-arrow");
    img.src = ICONS.arrow;
    img.alt = "";
    cell.append(img);
  } else if (row.kind === "match") {
    const img = makeEl("img", "relation-equals");
    img.src = ICONS.equals;
    img.alt = "";
    cell.append(img);
  } else if (row.kind === "conflict") {
    cell.append(makeEl("span", "diff-badge", `≠ ${row.targetLabel}`));
  } else {
    cell.textContent = "—";
  }
  return cell;
}

function makeActionCell(row) {
  const cell = makeEl("div", "action-cell");

  if (row.kind === "transfer") {
    const btn = makeEl("button", "action-btn", "Przenieś status");
    btn.type = "button";
    btn.addEventListener("click", () => migrateSingle(row, btn));
    cell.append(btn);
    return cell;
  }

  if (row.kind === "conflict") {
    const btn = makeEl("button", "action-btn conflict", "Przenieś status");
    btn.type = "button";
    btn.addEventListener("click", () => migrateSingle(row, btn));
    cell.append(btn);
    return cell;
  }

  if (row.kind === "unmatched") {
    const label = row.missing === "az" ? "Brak na AZ" : "Brak na OA";
    const btn = makeEl("button", "action-btn inactive-purple", label);
    btn.type = "button";
    btn.disabled = true;
    cell.append(btn);
    return cell;
  }

  const btn = makeEl("button", "action-btn neutral", "Już zgodny");
  btn.type = "button";
  btn.disabled = true;
  cell.append(btn);
  return cell;
}

function makeResultCard(row) {
  const card = makeEl("article", `result-card is-${row.kind}`);

  const title = makeEl("div", "title-block");
  if (row.oaCover) {
    const poster = makeEl("img", "title-poster");
    poster.src = row.oaCover;
    poster.alt = "";
    poster.loading = "lazy";
    title.append(poster);
  }
  const titleText = makeEl("div", "title-text");
  titleText.append(
    makeEl("h3", "main-title", row.azTitle || row.oaTitle),
    makeTitleLine(ICONS.oa, "ogladajanime.pl", OA_BASE, row.oaSlug, row.oaTitle),
    makeTitleLine(ICONS.az, "animezone.pl", AZ_BASE, row.azSlug, row.azTitle),
  );
  title.append(titleText);

  card.append(
    makeStateCell(row),
    title,
    makeStatusCell("ogladajanime.pl", row.oaStatusLabel),
    makeRelationCell(row),
    makeStatusCell("animezone.pl", row.azStatusLabel),
    makeActionCell(row),
  );

  return card;
}

function render() {
  const rows = rowsToShow();
  const counts = computeCounts(rows);
  const filteredRows =
    currentFilter === "all" ? rows : rows.filter((row) => row.kind === currentFilter);

  updateSummary(rows, counts);
  els.filters.hidden = false;
  els.results.hidden = false;
  els.migrationBar.hidden = false;
  els.results.replaceChildren();

  if (filteredRows.length === 0) {
    els.results.append(
      makeEl("div", "empty-state", `Brak pozycji w filtrze: ${filterLabels[currentFilter]}.`),
    );
    return rows.length;
  }

  els.results.append(...filteredRows.map(makeResultCard));
  return rows.length;
}

async function setStatusValue(azSlug, target) {
  const code = AZ_SET_CODE[target];
  const resp = await bgFetch(`${AZ_BASE}/anime/${azSlug}/watched/${code}`, "include");
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  azStatusBySlug.set(azSlug, target);
}

async function migrateSingle(row, btn) {
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Wysyłam...";

  try {
    await setStatusValue(row.azSlug, row.target);
    btn.textContent = "Ustawione";
    btn.classList.add("ok");
    setTimeout(render, 350);
  } catch (err) {
    btn.textContent = "Błąd";
    btn.classList.add("err");
    btn.title = err.message;
    btn.disabled = false;
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove("err");
    }, 3000);
  }
}

async function migrateTransferable() {
  if (!loaded || loading || migrationRunning) return;

  const rows = rowsToShow().filter((row) => row.kind === "transfer");
  if (rows.length === 0) {
    render();
    return;
  }

  migrationRunning = true;
  els.migrateBtn.disabled = true;

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    els.migrationTitle.textContent = `Ustawianie ${i + 1}/${rows.length}`;
    els.migrationMeta.textContent = `${row.azTitle || row.oaTitle}: ustawiam ${row.targetLabel}`;
    try {
      await setStatusValue(row.azSlug, row.target);
      ok += 1;
    } catch (err) {
      failed += 1;
      console.error(`Nie udało się ustawić ${row.azSlug}:`, err);
    }
    if (i < rows.length - 1) await sleep(THROTTLE_MS);
  }

  migrationRunning = false;
  render();
  els.migrationTitle.textContent = failed
    ? `Zakończono z błędami: ${ok} OK, ${failed} błędów`
    : `Ustawiono ${ok} ${formatCount(ok, "status", "statusy", "statusów")}`;
  els.migrationMeta.textContent = failed
    ? "Pozycje z błędem zostały na liście do przeniesienia. Konflikty nie były ruszane."
    : "Automatyczne ustawienie bezkonfliktowych statusów zakończone.";
}

async function loadAll() {
  if (loading) return;
  loading = true;
  loaded = false;
  setStatus("");
  setProfiles(false, false);
  hideAuthNotice();
  hideDataViews();

  try {
    if (master.length === 0) {
      try {
        await loadMaster();
      } catch (e) {
        setStatus(`Błąd wczytania mapowania: ${e.message}`, true);
        return;
      }
    }

    const [oaRes, azRes] = await Promise.allSettled([
      loadOaStatuses(),
      loadAzStatuses(),
    ]);
    const oaOk = oaRes.status === "fulfilled";
    const azOk = azRes.status === "fulfilled";

    setProfiles(oaOk, azOk);

    if (!oaOk || !azOk) {
      const services = [];
      if (!oaOk) {
        services.push({ label: "ogladajanime.pl", href: `${OA_BASE}/`, avatar: ICONS.oa });
      }
      if (!azOk) {
        services.push({ label: "animezone.pl", href: `${AZ_BASE}/`, avatar: ICONS.az });
      }
      showAuthNotice(services);
      hideDataViews();
      return;
    }

    hideAuthNotice();
    loaded = true;
    render();
    setStatus("");
  } finally {
    loading = false;
  }
}

els.filters.addEventListener("click", (event) => {
  const btn = event.target.closest(".filter-btn");
  if (!btn) return;
  currentFilter = btn.dataset.filter || "all";
  render();
});

els.migrateBtn.addEventListener("click", migrateTransferable);

function openSettings() {
  els.settingsRows.replaceChildren(
    ...OA_STATUS_CODES.map((code) => {
      const row = makeEl("div", "settings-row");
      row.append(makeEl("span", "", OA_STATUS[code]));
      const select = makeEl("select");
      select.dataset.code = String(code);
      for (const opt of TARGET_OPTIONS) {
        const o = makeEl("option", "", opt.label);
        o.value = opt.value;
        if (statusMapping[code] === opt.value) o.selected = true;
        select.append(o);
      }
      row.append(select);
      return row;
    }),
  );
  els.settingsModal.hidden = false;
}

function closeSettings() {
  els.settingsModal.hidden = true;
}

function resetSettings() {
  for (const select of els.settingsRows.querySelectorAll("select")) {
    select.value = DEFAULT_MAPPING[select.dataset.code];
  }
}

function saveSettings() {
  const map = {};
  for (const select of els.settingsRows.querySelectorAll("select")) {
    map[select.dataset.code] = select.value;
  }
  localStorage.setItem(MAPPING_KEY, JSON.stringify(map));
  location.reload();
}

els.settingsBtn.addEventListener("click", openSettings);
els.settingsClose.addEventListener("click", closeSettings);
els.settingsCancel.addEventListener("click", closeSettings);
els.settingsSave.addEventListener("click", saveSettings);
els.settingsReset.addEventListener("click", resetSettings);
els.settingsModal.addEventListener("click", (event) => {
  if (event.target === els.settingsModal) closeSettings();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.settingsModal.hidden) closeSettings();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !loaded) loadAll();
});

loadAll();
