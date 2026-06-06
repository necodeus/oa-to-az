"use strict";

const OA_BASE = "https://ogladajanime.pl";
const AZ_BASE = "https://www.animezone.pl";
const ICONS = {
  arrow: "assets/arrow-right.svg",
  check: "assets/check.svg",
  exclamation: "assets/exclamation.svg",
  question: "assets/question.svg",
  star: "assets/star.svg",
  equals: "assets/equals.svg",
  oa: "assets/oa.png",
  az: "assets/az.svg",
};

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
};

let master = [];
let oaBySlug = new Map();
let azBySlug = new Map();
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

async function loadMaster() {
  const resp = await fetch("data.ndjson");
  const text = await resp.text();
  master = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    const oaSlug = slugFromUrl(rec.oa_url);
    const azSlug = slugFromUrl(rec.az_url);
    if (!azSlug) continue;
    master.push({
      malId: rec.mal_id,
      malUrl: rec.mal_url,
      oaTitle: rec.oa_title || oaSlug || "Bez dopasowania",
      azTitle: rec.az_title || azSlug,
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

async function loadOaRatings() {
  oaBySlug = new Map();
  oaUser = null;
  oaId = await detectOaId();
  try {
    oaUser = await detectOaUserName(oaId);
  } catch (err) {
    console.warn("Nie udało się pobrać nicku OA:", err);
  }
  const resp = await bgFetch(`${OA_BASE}/anime_list/${oaId}`, "omit");
  if (!resp.ok) throw new Error(`OA HTTP ${resp.status}`);
  const doc = new DOMParser().parseFromString(resp.text, "text/html");
  for (const tr of doc.querySelectorAll('tr[id^="anime_list_item_"]')) {
    const cells = tr.querySelectorAll(":scope > td");
    const link = cells[2] && cells[2].querySelector('a[href^="/anime/"]');
    if (!link) continue;
    const slug = slugFromUrl(link.getAttribute("href"));
    const rating = parseInt((cells[4] || {}).textContent, 10);
    oaBySlug.set(slug, {
      rating: Number.isFinite(rating) ? rating : 0,
      status: cells[3] ? cells[3].textContent.trim() : "",
      progress: cells[5] ? cells[5].textContent.trim() : "",
      cover: coverUrl(tr, OA_BASE),
      title: link.textContent.trim(),
    });
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

async function loadAzRatings() {
  azBySlug = new Map();
  azUser = await detectAzUser();
  const resp = await bgFetch(
    `${AZ_BASE}/user/${encodeURIComponent(azUser)}/rated`,
    "include",
  );
  if (!resp.ok) throw new Error(`AZ HTTP ${resp.status}`);
  const doc = new DOMParser().parseFromString(resp.text, "text/html");
  for (const block of doc.querySelectorAll(".well.categories")) {
    const link = block.querySelector('a[href^="/anime/"]');
    if (!link) continue;
    const slug = slugFromUrl(link.getAttribute("href"));
    const label = block.querySelector(".label-dark");
    const m = label && /Ocena\s+(\d+)/.exec(label.textContent);
    const status = block.querySelector(".info small");
    azBySlug.set(slug, {
      rating: m ? parseInt(m[1], 10) : 0,
      status: status ? status.textContent.replace(/.*Status:\s*/, "").trim() : "",
    });
  }
}

function classifyRow(row) {
  if (!row.oaSlug) return "unmatched";
  if (row.azRating === 0) return "transfer";
  if (row.oaRating === row.azRating) return "match";
  return "conflict";
}

function rowsToShow() {
  const priority = { transfer: 0, conflict: 1, match: 2, unmatched: 3 };
  const mappedOa = new Set();
  const rows = [];

  for (const m of master) {
    const oa = m.oaSlug ? oaBySlug.get(m.oaSlug) : null;
    const az = azBySlug.get(m.azSlug);
    if (m.oaSlug) mappedOa.add(m.oaSlug);
    const row = {
      ...m,
      oaRating: oa ? oa.rating : 0,
      oaStatus: oa ? oa.status : "",
      oaProgress: oa ? oa.progress : "",
      oaCover: oa ? oa.cover : "",
      azRating: az ? az.rating : 0,
      azStatus: az ? az.status : "",
      hasOaEntry: Boolean(oa),
      hasAzEntry: Boolean(az),
    };
    if (row.oaRating <= 0 && !(!row.oaSlug && row.hasAzEntry)) continue;
    if (!row.oaSlug) {
      row.kind = "unmatched";
      row.missing = "oa";
    } else {
      row.kind = classifyRow(row);
    }
    rows.push(row);
  }

  for (const [oaSlug, oa] of oaBySlug) {
    if (oa.rating <= 0 || mappedOa.has(oaSlug)) continue;
    rows.push({
      oaSlug,
      azSlug: null,
      oaTitle: oa.title || oaSlug,
      azTitle: "",
      oaRating: oa.rating,
      oaStatus: oa.status,
      oaProgress: oa.progress,
      oaCover: oa.cover,
      azRating: 0,
      azStatus: "",
      hasOaEntry: true,
      hasAzEntry: false,
      kind: "unmatched",
      missing: "az",
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
  const counts = {
    all: rows.length,
    transfer: 0,
    match: 0,
    conflict: 0,
    unmatched: 0,
  };
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
        makeEl("p", "", card.meta || " "),
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
        "ocena zostanie przeniesiona",
        "oceny zostaną przeniesione",
        "ocen zostanie przeniesionych",
      )}`
    : "Brak ocen do automatycznego przeniesienia";
  els.migrationMeta.textContent = transferable
    ? "Konflikty i pozycje bez dopasowania wymagają ręcznej decyzji."
    : "Konflikty i pozycje bez dopasowania wymagają ręcznej decyzji.";
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

function makeRatingCell(source, rating) {
  const cell = makeEl("div", "rating-cell");
  cell.append(makeEl("p", "rating-source", source));
  const value = makeEl("div", `rating-value${rating > 0 ? "" : " empty"}`);
  if (rating > 0) {
    const star = makeEl("img", "rating-star");
    star.src = ICONS.star;
    star.alt = "";
    value.append(star, document.createTextNode(`${rating}/10`));
  } else {
    value.textContent = "—";
  }
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
    const diff = row.azRating - row.oaRating;
    cell.append(makeEl("span", "diff-badge", `${diff > 0 ? "+" : ""}${diff}`));
  } else {
    cell.textContent = "—";
  }
  return cell;
}

function makeActionCell(row) {
  const cell = makeEl("div", "action-cell");

  if (row.kind === "transfer") {
    const btn = makeEl("button", "action-btn", "Przenieś ocenę");
    btn.type = "button";
    btn.addEventListener("click", () => migrateSingle(row, btn));
    cell.append(btn);
    return cell;
  }

  if (row.kind === "conflict") {
    const btn = makeEl("button", "action-btn conflict", "Przenieś ocenę");
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

  const btn = makeEl("button", "action-btn neutral", "Już zgodne");
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
    makeRatingCell("ogladajanime.pl", row.oaRating),
    makeRelationCell(row),
    makeRatingCell("animezone.pl", row.azRating),
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

async function setRatingValue(azSlug, score) {
  const resp = await bgFetch(`${AZ_BASE}/anime/${azSlug}/rating/${score}`, "include");
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  azBySlug.set(azSlug, { rating: score, status: "" });
}

async function migrateSingle(row, btn) {
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Wysyłam...";

  try {
    await setRatingValue(row.azSlug, row.oaRating);
    btn.textContent = "Przeniesione";
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
    els.migrationTitle.textContent = `Przenoszenie ${i + 1}/${rows.length}`;
    els.migrationMeta.textContent = `${row.azTitle}: ustawiam ocenę ${row.oaRating}`;
    try {
      await setRatingValue(row.azSlug, row.oaRating);
      ok += 1;
    } catch (err) {
      failed += 1;
      console.error(`Nie udało się przenieść ${row.azSlug}:`, err);
    }
  }

  migrationRunning = false;
  render();
  els.migrationTitle.textContent = failed
    ? `Zakończono z błędami: ${ok} OK, ${failed} błędów`
    : `Przeniesiono ${ok} ocen`;
  els.migrationMeta.textContent = failed
    ? "Pozycje z błędem zostały na liście do przeniesienia. Konflikty nie były ruszane."
    : "Automatyczne przeniesienie bezkonfliktowych pozycji zakończone.";
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
      loadOaRatings(),
      loadAzRatings(),
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

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !loaded) loadAll();
});

loadAll();
