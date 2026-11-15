const snapshot = window.SAMPLE_SNAPSHOT;
const config = window.DASHBOARD_CONFIG || {};
let lastData = null;
let lastSuccessAt = null;
let errorText = "";
const HOUR = 60 * 60 * 1000;
const SVG_NS = "http://www.w3.org/2000/svg";
const dateFormat = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});
const hourFormat = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  hour: "2-digit",
  hourCycle: "h23"
});

function validTime(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function dateText(value) {
  return validTime(value) ? dateFormat.format(new Date(value)) : "기록 없음";
}

function renderQueryStatus() {
  const status = document.querySelector("#freshness");
  const updatedAt = document.querySelector("#updated-at");
  const viewContext = document.querySelector("#view-context");
  const waiting = !lastData && !errorText;

  status.className = "connection-status " + (waiting ? "neutral" : errorText ? "danger" : "good");
  status.textContent = waiting ? "확인 중" : errorText ? "조회 실패" : "조회 정상";
  updatedAt.textContent = lastSuccessAt
    ? "마지막 조회 성공: " + dateText(lastSuccessAt)
    : "조회 성공 기록이 없습니다.";
  viewContext.textContent = "현재 시각 기준";
  document.querySelector("#data-errors").hidden = true;
}

function renderDataError(data, message) {
  const notice = document.querySelector("#data-errors");
  notice.hidden = !message;
  notice.textContent = message
    ? "현재 자료를 가져오지 못했습니다. " + message + (data ? " 아래 내용은 이전 조회 자료입니다." : " 조회할 자료가 없습니다.")
    : "";
}

function hourText(value) {
  return validTime(value) ? hourFormat.format(new Date(value)) : "기록 없음";
}

function ageText(value, now) {
  if (!validTime(value) || Date.parse(value) > now) return "시각 확인 필요";
  return Math.floor((now - Date.parse(value)) / 60000) + "분 전";
}

function freshness(value, now) {
  if (!validTime(value) || Date.parse(value) > now) return "missing";
  return now - Date.parse(value) > 30 * 60 * 1000 ? "stale" : "fresh";
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function numberText(value) {
  return integer(value) ? value.toLocaleString("ko-KR") : "확인 불가";
}

function progressText(completed, target) {
  if (!integer(completed) || !integer(target) || target === 0) {
    return "계획 대비 목표를 확인해 주세요";
  }
  return (completed / target * 100).toFixed(1) + "%";
}

function apiUrl(base, path, params = "") {
  const address = base.replace(/\/$/, "");
  const query = String(params);
  if (address.endsWith("/exec")) {
    return address + "?path=" + path + (query ? "&" + query : "");
  }
  return address + path + (query ? "?" + query : "");
}

async function requestJson(url) {
  const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const body = await response.json();
    if (body && typeof body.error === "string") throw new Error(body.error);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeSnapshot(data) {
  const viewTime = data.viewTime || data.serverTime;
  const normalized = { ...data, viewTime, sites: {}, services: {} };
  for (const id of ["factory", "warehouse"]) {
    const source = data.sites?.[id] || {};
    const site = {
      target: integer(source.target) ? source.target : null,
      completed: integer(source.completed) ? source.completed : null,
      status: ["normal", "warning", "error"].includes(source.status) ? source.status : "unknown",
      note: typeof source.note === "string" ? source.note : "기록 대기",
      processingState: ["completed", "paused", "waiting"].includes(source.processingState)
        ? source.processingState
        : validTime(source.processedAt) ? "completed" : "waiting"
    };

    for (const key of ["lastEventAt", "receivedAt", "processedAt"]) {
      site[key] = validTime(source[key]) && Date.parse(source[key]) <= Date.parse(viewTime)
        ? source[key]
        : null;
    }

    const history = source.history;
    site.history = Array.isArray(history) && history.length <= 24 && history.every(point =>
      point && validTime(point.timestamp) && Date.parse(point.timestamp) <= Date.parse(data.serverTime) && integer(point.quantity)
    )
      ? [...history].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
      : [];

    site.image = source.image && typeof source.image.url === "string" && typeof source.image.alt === "string"
      ? source.image
      : null;
    normalized.sites[id] = site;
  }

  const sourceAlerts = data.services?.alerts || {};
  normalized.services.alerts = {
    status: ["sent", "failed"].includes(sourceAlerts.status) ? sourceAlerts.status : "unknown",
    lastAttemptAt: validTime(sourceAlerts.lastAttemptAt) && Date.parse(sourceAlerts.lastAttemptAt) <= Date.parse(viewTime)
      ? sourceAlerts.lastAttemptAt
      : null,
    note: typeof sourceAlerts.note === "string" ? sourceAlerts.note : ""
  };
  normalized.incidents = Array.isArray(data.incidents) ? data.incidents : [];
  return normalized;
}

function emptySnapshot() {
  const emptySite = () => ({
    target: null,
    completed: null,
    status: "unknown",
    note: "기록 대기",
    processingState: "waiting",
    lastEventAt: null,
    receivedAt: null,
    processedAt: null,
    history: [],
    image: null
  });
  return {
    viewTime: null,
    serverTime: null,
    sites: { factory: emptySite(), warehouse: emptySite() },
    services: { alerts: { status: "unknown", lastAttemptAt: null, note: "" } },
    incidents: []
  };
}

async function readSnapshot() {
  if (typeof config.apiBaseUrl !== "string" || !/^https?:\/\//.test(config.apiBaseUrl)) {
    throw new Error("API 연결 주소가 설정되지 않았습니다.");
  }
  const response = await requestJson(apiUrl(config.apiBaseUrl, "/api/v1/snapshot"));
  return normalizeSnapshot(response);
}

function fillQuantity(id, noun, site) {
  const quantity = document.querySelectorAll("#" + id + "-quantity span");
  const completedText = quantity[0];
  const targetText = quantity[1];
  const completedValid = integer(site.completed);
  const targetValid = integer(site.target);
  const valid = completedValid && targetValid && site.target !== 0;
  const rate = valid ? site.completed / site.target * 100 : null;
  const rateText = valid ? rate.toFixed(1) + "%" : "계획 대비 목표를 확인해 주세요";
  const label = id === "factory" ? "텀블공장" : "물류창고";

  completedText.textContent = noun + " " + numberText(site.completed) + (completedValid ? "개" : "");
  targetText.textContent = "· 목표 " + numberText(site.target) + (targetValid ? "개" : "");

  const progressTextElement = document.querySelector("#" + id + "-progress-text");
  const progress = document.querySelector("#" + id + "-progress");
  const exceeded = document.querySelector("#" + id + "-exceeded");
  progressTextElement.textContent = valid ? "계획 대비 " + rateText : rateText;
  progress.hidden = !valid;
  exceeded.hidden = !(valid && site.completed > site.target);

  if (valid) {
    progress.value = Math.min(100, rate);
    progress.setAttribute("aria-label", label + " 목표 달성률 " + rateText);
  }
}

function setBadge(element, status) {
  const names = {
    normal: ["good", "정상"],
    warning: ["warning", "확인 필요"],
    error: ["danger", "오류"],
    sent: ["good", "전송 성공"],
    failed: ["danger", "실패"],
    waiting: ["neutral", "대기"]
  };
  const [tone, text] = names[status] || ["neutral", "확인 필요"];
  element.className = "badge " + tone;
  element.textContent = text;
}

function renderSite(id, site, viewTime, alerts) {
  const noun = id === "factory" ? "생산" : "출고";
  const label = id === "factory" ? "텀블공장" : "물류창고";
  fillQuantity(id, noun, site);

  const valid = integer(site.completed) && integer(site.target) && site.target !== 0;
  const rateText = progressText(site.completed, site.target);
  const progressTextElement = document.querySelector("#" + id + "-progress-text");
  const progress = document.querySelector("#" + id + "-progress");
  const exceeded = document.querySelector("#" + id + "-exceeded");
  progressTextElement.textContent = valid ? "계획 대비 " + rateText : "계획 대비 목표를 확인해 주세요";
  progress.hidden = !valid;
  exceeded.hidden = !(valid && site.completed > site.target);
  if (valid) {
    progress.value = Math.min(100, site.completed / site.target * 100);
    progress.setAttribute("aria-label", label + " 목표 달성률 " + rateText);
  }

  renderPhoto(
    document.querySelector("#" + id + "-photo"),
    id === "factory" ? "공장 생산 참고 사진" : "창고 출고 참고 사진",
    site
  );
  renderGraph(id, label, site.history);

  const age = freshness(site.lastEventAt, viewTime);
  const status = age === "missing" ? "waiting" : age === "stale" ? "warning" : site.status;
  const card = document.querySelector("#" + id + "-status");
  card.className = "card status-card" + (status === "error" ? " danger" : "");
  setBadge(card.querySelector(".badge"), status);
  card.querySelector(".card-description").textContent = site.note;
  card.querySelector(".meta").textContent = "기준 시각 대비: " + ageText(site.lastEventAt, viewTime) + " · 발생 시각: " + dateText(site.lastEventAt);
  renderFlow(id, site, label, status, age);

  const alertsCard = document.querySelector("#alerts-status");
  alertsCard.className = "card status-card" + (alerts.status === "failed" ? " danger" : "");
  setBadge(alertsCard.querySelector(".badge"), alerts.status);
  const alertDescription = alerts.status === "sent"
    ? "알림 전송이 완료됐습니다."
    : alerts.status === "failed"
      ? "담당자에게 알림을 전달하지 못했습니다."
      : "전송 기록을 확인할 수 없습니다.";
  alertsCard.querySelector(".card-description").textContent = alertDescription;
  alertsCard.querySelector(".meta").textContent = "마지막 전송 시도: " + dateText(alerts.lastAttemptAt);
}

function renderPhoto(slot, caption, site) {
  const image = site.image;
  const key = image ? image.url + "\n" + image.alt : "none";
  if (slot.dataset.photo === key) return;
  slot.dataset.photo = key;

  if (!image) {
    const placeholder = document.createElement("div");
    placeholder.className = "photo-placeholder";
    placeholder.textContent = "현장 사진 없음";
    const description = document.createElement("figcaption");
    description.textContent = caption;
    slot.replaceChildren(placeholder, description);
    return;
  }

  const img = document.createElement("img");
  img.src = image.url;
  img.alt = image.alt.trim() || caption;
  img.loading = "lazy";
  img.onerror = () => {
    img.remove();
    const placeholder = document.createElement("div");
    placeholder.className = "photo-placeholder";
    placeholder.textContent = "현장 사진을 불러오지 못했습니다.";
    slot.prepend(placeholder);
  };
  const description = document.createElement("figcaption");
  description.textContent = caption;
  slot.replaceChildren(img, description);
}

function renderFlow(id, site, label, status, age) {
  const card = document.querySelector("#" + id + "-flow");
  const title = document.createElement("div");
  title.className = "status-line";
  const badge = document.createElement("span");
  setBadge(badge, status);
  title.append(document.createElement("h3"), badge);
  title.querySelector("h3").textContent = label;

  const content = [title, Object.assign(document.createElement("p"), { className: "card-description", textContent: site.note })];
  if (age === "stale") {
    content.push(Object.assign(document.createElement("p"), { className: "notice", textContent: "기록이 30분 넘게 들어오지 않았습니다." }));
  }
  if (age === "missing") {
    content.push(Object.assign(document.createElement("p"), { className: "notice", textContent: "현장 기록을 기다리고 있습니다." }));
  }

  const list = document.createElement("dl");
  list.className = "time-list";
  for (const [key, name] of [["lastEventAt", "기록 발생"], ["receivedAt", "서버 접수"], ["processedAt", "서버 처리"]]) {
    const row = document.createElement("div");
    const value = validTime(site[key])
      ? dateText(site[key])
      : key === "processedAt" && site.processingState === "paused"
        ? "처리 중단"
        : "기록 대기";
    const term = document.createElement("dt");
    term.textContent = name;
    const description = document.createElement("dd");
    description.textContent = value;
    row.append(term, description);
    list.append(row);
  }
  content.push(list);
  card.replaceChildren(...content);
}

function currentIssues(data) {
  const unique = new Map();
  for (const item of data?.incidents || []) {
    if (item.id !== "PREDICTION-JOB" && !unique.has(item.id)) {
      unique.set(item.id, item);
    }
  }
  return [...unique.values()].sort((a, b) => {
    return (a.level === "error" ? 0 : 1) - (b.level === "error" ? 0 : 1);
  });
}

function toggleNotifications(force) {
  const panel = document.querySelector("#notification-dropdown");
  const button = document.querySelector("#header-alerts-link");
  const open = typeof force === "boolean" ? force : panel.hidden;
  panel.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
}

function renderNotifications(issues) {
  const panel = document.querySelector("#notification-dropdown");
  const button = document.querySelector("#header-alerts-link");
  const countText = "알림 " + issues.length + "건";
  const key = JSON.stringify(issues.map(issue => [issue.id, issue.level, issue.title, issue.owner, issue.action]));

  if (panel.dataset.renderedKey !== key) {
    const fragment = document.createDocumentFragment();
    fragment.append(Object.assign(document.createElement("h2"), { textContent: "알림" }));

    if (issues.length === 0) {
      fragment.append(Object.assign(document.createElement("p"), { textContent: "확인할 알림이 없습니다." }));
    }

    for (const issue of issues) {
      const entry = document.createElement("article");
      entry.className = "notification-item";
      entry.append(
        Object.assign(document.createElement("h3"), { textContent: issue.title }),
        Object.assign(document.createElement("p"), { textContent: "담당자: " + issue.owner }),
        Object.assign(document.createElement("p"), { textContent: "할 일: " + issue.action })
      );
      fragment.append(entry);
    }

    panel.replaceChildren(fragment);
    panel.dataset.renderedKey = key;
  }

  document.querySelector("#header-alerts-text").textContent = countText;
  button.setAttribute("aria-label", countText);
  button.className = "alerts-link " + (issues.some(issue => issue.level === "error")
    ? "danger"
    : issues.length > 0 ? "warning" : "good");
}

function renderHero(issues) {
  const hero = document.querySelector("#hero");
  const title = document.querySelector("#hero-title");
  const owner = document.querySelector("#hero-owner");
  const action = document.querySelector("#hero-action");
  const first = issues[0];

  hero.className = "hero" + (first ? "" : " neutral");
  owner.hidden = !first;

  if (!first) {
    title.textContent = "우선 확인할 문제가 없습니다.";
    action.textContent = "운영 담당자 · 기록 갱신 상태를 계속 확인해 주세요.";
    return;
  }

  let guidance = "";
  if (first.scope === "factory" || first.id === "FACTORY-FEED") {
    guidance = "생산 기록 보기에서 마지막 기록을 확인하세요. ";
  } else if (first.scope === "warehouse" || first.id === "WAREHOUSE-FEED") {
    guidance = "출고 기록 보기에서 마지막 기록을 확인하세요. ";
  } else if (first.id === "ALERT-DELIVERY") {
    guidance = "아래 알림 전송 기록에서 마지막 시도와 실패 여부를 확인하세요. ";
  }

  title.textContent = first.title;
  owner.textContent = "담당자: " + first.owner;
  action.textContent = "확인할 일: " + guidance + first.action;
}

function setupNotificationEvents() {
  const button = document.querySelector("#header-alerts-link");
  button.addEventListener("click", () => toggleNotifications());
}

function positionHelpPopover(popover) {
  if (popover.hidden) return;
  popover.style.translate = "none";
  const bounds = popover.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  let min = 16;
  let max = viewportWidth - 16;
  const card = popover.closest(".card, .hero")?.getBoundingClientRect();

  if (card && Math.min(max, card.right) - Math.max(min, card.left) >= bounds.width) {
    min = Math.max(min, card.left);
    max = Math.min(max, card.right);
  }

  const left = Math.max(min, Math.min(bounds.left, max - bounds.width));
  popover.style.translate = (left - bounds.left) + "px 0";
}

function closeHelp(popover) {
  const button = popover.closest(".help-wrap").querySelector(".help-btn");
  popover.hidden = true;
  button.setAttribute("aria-expanded", "false");
  button.dataset.pinned = "false";
}

function openHelps() {
  return document.querySelectorAll(".help-popover:not([hidden])");
}

function setupHelp(button) {
  const wrap = button.closest(".help-wrap");
  const popover = wrap.querySelector(".help-popover");

  function open() {
    for (const other of openHelps()) {
      if (other !== popover) closeHelp(other);
    }
    toggleNotifications(false);
    popover.hidden = false;
    button.setAttribute("aria-expanded", "true");
    positionHelpPopover(popover);
  }

  button.dataset.pinned = "false";
  button.addEventListener("mouseenter", open);
  wrap.addEventListener("mouseleave", () => {
    if (document.activeElement !== button && button.dataset.pinned !== "true") closeHelp(popover);
  });
  button.addEventListener("focus", open);
  button.addEventListener("blur", () => {
    if (button.dataset.pinned !== "true") closeHelp(popover);
  });
  button.addEventListener("click", () => {
    if (button.dataset.pinned !== "true") {
      button.dataset.pinned = "true";
      open();
    } else {
      closeHelp(popover);
    }
  });
}

function setupOverlayEvents() {
  document.addEventListener("click", event => {
    if (!event.target.closest(".notification-wrap")) toggleNotifications(false);
    if (!event.target.closest(".help-wrap")) {
      for (const popover of openHelps()) closeHelp(popover);
    }
  });

  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if (!document.querySelector("#notification-dropdown").hidden) {
      toggleNotifications(false);
      document.querySelector("#header-alerts-link").focus();
    }
    for (const popover of openHelps()) {
      popover.closest(".help-wrap").querySelector(".help-btn").focus();
      closeHelp(popover);
    }
  });

  window.addEventListener("resize", () => {
    for (const popover of openHelps()) positionHelpPopover(popover);
  });
}

function dayInSeoul(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));
}

function localDateTime(value) {
  return new Date(Date.parse(value) + 9 * HOUR).toISOString().slice(0, 19);
}

function fromLocal(value) {
  return Date.parse(value + "+09:00");
}

function recordStatus(value) {
  if (value === "completed") return "완료";
  if (value === "receipt-wait") return "접수 대기";
  return "처리 대기";
}

function createRecordTable(headers, rows) {
  const wrapper = document.createElement("div");
  wrapper.className = "table-scroll";
  wrapper.tabIndex = 0;
  wrapper.setAttribute("aria-label", "기록 표. 좌우로 이동할 수 있습니다.");

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const text of headers) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = text;
    headerRow.append(cell);
  }
  thead.append(headerRow);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tableRow = document.createElement("tr");
    for (const text of row) {
      const cell = document.createElement("td");
      cell.textContent = text;
      tableRow.append(cell);
    }
    tbody.append(tableRow);
  }
  table.append(thead, tbody);
  wrapper.append(table);
  return wrapper;
}

function keepScroll(container, draw, sameScreen) {
  const before = !sameScreen ? [] : [".table-scroll", ".history-strip"].map(selector => {
    const old = container.querySelector(selector);
    return old ? [selector, old.scrollLeft, old === document.activeElement] : null;
  }).filter(Boolean);

  draw();

  for (const [selector, scrollLeft, hadFocus] of before) {
    const next = container.querySelector(selector);
    if (!next) continue;
    next.scrollLeft = scrollLeft;
    if (hadFocus) next.focus({ preventScroll: true });
  }
}

let recordFrom = "";
let recordTo = "";
let recordsView = "";
let renderedRecordsHash = null;
let renderedHash = null;

function renderRecords(data, id, sameScreen) {
  const from = document.querySelector("#record-from");
  const to = document.querySelector("#record-to");
  const day = dayInSeoul(data.viewTime);
  const end = localDateTime(data.viewTime);
  from.min = to.min = day + "T00:00:00";
  from.max = to.max = end;
  from.value = recordFrom || day + "T00:00:00";
  to.value = recordTo || end;

  const kind = id === "factory" ? "production" : "shipment";
  const startTime = fromLocal(from.value);
  const endTime = fromLocal(to.value);
  const validRange = Number.isFinite(startTime) && Number.isFinite(endTime) && startTime <= endTime;
  const records = validRange ? window.SAMPLE_RECORDS[kind].filter(record => {
    const occurred = Date.parse(record.occurredAt);
    return occurred >= startTime && occurred <= endTime;
  }) : [];
  const rows = records.map(record => [
    dateText(record.occurredAt),
    numberText(record.quantity) + "개",
    validTime(record.receivedAt) ? dateText(record.receivedAt) : "접수 대기",
    validTime(record.processedAt) ? dateText(record.processedAt) : "처리 대기",
    recordStatus(record.status)
  ]);
  const result = document.querySelector("#records-result");
  const key = JSON.stringify(rows);
  if (recordsView === key) {
    renderedRecordsHash = location.hash;
    return;
  }

  recordsView = key;
  keepScroll(result, () => result.replaceChildren(rows.length
    ? createRecordTable(["발생 시각", "수량", "서버 접수", "서버 처리", "상태"], rows)
    : Object.assign(document.createElement("p"), {
      className: "notice",
      textContent: "선택한 시간대에 기록이 없습니다."
    })), sameScreen && renderedRecordsHash === location.hash);
  renderedRecordsHash = location.hash;
}

document.querySelector("#record-from").addEventListener("input", event => {
  recordFrom = event.currentTarget.value;
});
document.querySelector("#record-to").addEventListener("input", event => {
  recordTo = event.currentTarget.value;
});
document.querySelector("#record-filter").addEventListener("submit", event => {
  event.preventDefault();
  recordFrom = document.querySelector("#record-from").value;
  recordTo = document.querySelector("#record-to").value;
  render();
});

for (const scroller of document.querySelectorAll(".graph-scroll")) {
  scroller.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    scroller.scrollLeft = event.key === "Home"
      ? 0
      : event.key === "End"
        ? scroller.scrollWidth
        : scroller.scrollLeft + (event.key === "ArrowRight" ? 90 : -90);
  });
}

function createGraph(label, points) {
  const max = Math.max(1, ...points.map(point => point.quantity));
  const firstTime = Date.parse(points[0].timestamp);
  const lastTime = Date.parse(points[points.length - 1].timestamp);
  const slots = Math.round((lastTime - firstTime) / HOUR) + 1;
  const width = 80 + slots * 90;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 " + width + " 190");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", "190");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label + " 시간별 완료 수량: " + points.map(point => dateText(point.timestamp) + " " + point.quantity + "개").join(", "));

  function draw(tag, attributes, text) {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) {
      element.setAttribute(key, String(value));
    }
    if (text !== undefined) element.textContent = text;
    svg.append(element);
  }

  draw("text", { x: 0, y: 20, "font-size": 16, fill: "#545b57" }, "개");
  draw("line", { x1: 35, y1: 150, x2: width - 15, y2: 150, stroke: "#bfc7c1" });

  for (const point of points) {
    const x = 40 + Math.round((Date.parse(point.timestamp) - firstTime) / HOUR) * 90;
    const height = point.quantity / max * 95;
    draw("rect", { x, y: 150 - height, width: 38, height, rx: 3, fill: "#47594d" });
    draw("text", { x, y: 145 - height, "font-size": 16, fill: "#222724" }, String(point.quantity));
    draw("text", { x, y: 177, "font-size": 16, fill: "#545b57" }, hourText(point.timestamp));
  }

  return svg;
}

function renderGraph(id, label, history) {
  const box = document.querySelector("#" + id + "-graph");
  const loading = box.querySelector(".loading-graph");
  const empty = box.querySelector(".graph-empty");
  const scroller = box.querySelector(".graph-scroll");
  const caption = box.querySelector(".graph-caption");
  const points = Array.isArray(history) ? history.filter(point => validTime(point.timestamp)) : [];
  const hasPoints = points.length > 0;

  loading.hidden = true;
  empty.hidden = hasPoints;
  scroller.hidden = !hasPoints;
  caption.hidden = !hasPoints;
  scroller.replaceChildren(...(hasPoints ? [createGraph(label, points)] : []));
}

function render(data = lastData) {
  lastData = data;
  renderQueryStatus();
  document.querySelector("#page-content").setAttribute("aria-busy", String(!data));
  renderDataError(data, errorText);
  if (!data) {
    data = emptySnapshot();
    lastData = null;
  }

  const route = resolveRoute(location.hash);
  const sameScreen = renderedHash === location.hash;
  renderedHash = location.hash;
  const pageTitle = document.querySelector("#page-title");
  const pageDescription = document.querySelector("#page-description");
  const todayView = document.querySelector("#today-view");
  const recordsView = document.querySelector("#records-view");
  const queriesView = document.querySelector("#queries-view");
  const backLink = document.querySelector("#back-link");
  const routeNotice = document.querySelector("#route-notice");
  const issues = currentIssues(data);
  renderNotifications(issues);
  renderHero(issues);

  todayView.hidden = route.view !== "today";
  recordsView.hidden = route.view !== "records";
  queriesView.hidden = route.view !== "queries";
  backLink.hidden = route.view === "today";
  routeNotice.hidden = !route.isUnknown;

  if (route.view === "records") {
    const noun = route.id === "factory" ? "생산" : "출고";
    pageTitle.textContent = "오늘 " + noun + " 기록";
    pageDescription.textContent = "선택한 기준 시각까지의 기록입니다. 수량은 수정하지 않습니다.";
    renderRecords(data, route.id, sameScreen);
  } else if (route.view === "queries") {
    const noun = route.id === "factory" ? "생산" : "출고";
    pageTitle.textContent = noun + " 데이터 조회 기록";
    pageDescription.textContent = "이 브라우저 탭의 최근 200건입니다. 실제 요청 시각과 조회 대상 시각을 구분합니다.";
    keepScroll(queriesView, () => queriesView.replaceChildren(Object.assign(document.createElement("p"), {
      className: "notice",
      textContent: "조회 기록이 없습니다."
    })), sameScreen);
  } else {
    pageTitle.textContent = "오늘 운영";
    pageDescription.textContent = "생산·출고 실적과 운영 상태를 살펴봅니다.";
  }

  const viewTime = Date.parse(data.viewTime);
  renderSite("factory", data.sites.factory, viewTime, data.services.alerts);
  renderSite("warehouse", data.sites.warehouse, viewTime, data.services.alerts);
}

function resolveRoute(hash) {
  const raw = (hash || "").replace(/^#\/?/, "");
  if (!raw || raw === "today") return { view: "today", id: null, isUnknown: false };
  const match = /^(records|queries)\/(factory|warehouse)$/.exec(raw);
  if (match) return { view: match[1], id: match[2], isUnknown: false };
  return { view: "today", id: null, isUnknown: true };
}

setupNotificationEvents();
for (const button of document.querySelectorAll(".help-btn")) {
  setupHelp(button);
}
setupOverlayEvents();
window.addEventListener("hashchange", () => {
  render();
  window.scrollTo(0, 0);
});

const POLL_INTERVAL_MS = 10000;
let polling = false;
let pollTimer = null;
let nextPollAt = null;
const refreshButton = document.querySelector("#refresh-btn");
const countdownText = document.querySelector("#countdown-text");

function clearPollSchedule() {
  clearTimeout(pollTimer);
  pollTimer = null;
  nextPollAt = null;
}

function scheduleNextPoll() {
  clearPollSchedule();
  nextPollAt = Date.now() + POLL_INTERVAL_MS;
  pollTimer = setTimeout(() => {
    clearPollSchedule();
    poll();
  }, POLL_INTERVAL_MS);
  updateCountdown();
}

function updateCountdown() {
  if (polling || !nextPollAt) {
    countdownText.textContent = "조회 중…";
    return;
  }

  const remaining = nextPollAt - Date.now();
  if (remaining <= 0) {
    clearPollSchedule();
    poll();
    return;
  }

  countdownText.textContent = "다음 조회 " + Math.max(1, Math.ceil(remaining / 1000)) + "초";
}

async function poll() {
  if (polling) return;
  clearPollSchedule();
  polling = true;
  updateRefreshButton();
  try {
    const data = await readSnapshot();
    lastData = data;
    lastSuccessAt = new Date().toISOString();
    errorText = "";
    render(data);
  } catch (error) {
    errorText = String(error?.message || error);
    render(lastData);
  } finally {
    polling = false;
    updateRefreshButton();
    scheduleNextPoll();
  }
}

function updateRefreshButton() {
  refreshButton.setAttribute("aria-disabled", String(polling));
  refreshButton.setAttribute("aria-busy", String(polling));
  refreshButton.classList.toggle("loading", polling);
}

refreshButton.addEventListener("click", () => {
  if (polling) return;
  clearPollSchedule();
  poll();
});

updateRefreshButton();
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (!polling && nextPollAt && Date.now() >= nextPollAt) {
    clearPollSchedule();
    poll();
  } else {
    updateCountdown();
  }
});

poll();
setInterval(updateCountdown, 250);