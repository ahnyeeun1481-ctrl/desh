const config = window.DASHBOARD_CONFIG || {};
let lastData = null;
let lastSuccessAt = null;
let errorText = "";
let selectedAt = "";
let viewGeneration = 0;
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
  viewContext.replaceChildren();
  viewContext.append(document.createTextNode(selectedAt
    ? dateText(selectedAt) + " 기준 · 과거 자료"
    : "현재 시각 기준"));
  if (selectedAt) {
    const back = document.createElement("button");
    back.type = "button";
    back.className = "inline-button";
    back.textContent = "현재로 돌아가기";
    back.addEventListener("click", () => changeView(""));
    viewContext.append(back);
  }
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
    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
    } catch {
      if (controller.signal.aborted) {
        const seconds = String(Math.round(timeoutMs / 100) / 10);
        throw new Error("서버가 " + seconds + "초 안에 응답하지 않았습니다. 잠시 후 다시 조회하고, 계속되면 서버를 실행한 창의 기록(로그)을 확인하거나 강사에게 알려 주세요.");
      }
      throw new Error("API 서버에 연결하지 못했습니다. 연결 주소가 맞는지, 직접 띄운 서버라면 켜져 있는지 확인해 주세요. GAS 웹 앱이라면 편집기에서 함수를 한 번 실행해 권한을 승인했는지도 확인해 주세요.");
    }
    if (!response.ok) throw new Error(httpErrorMessage(response.status));
    let body;
    try {
      body = await response.json();
    } catch {
      if (controller.signal.aborted) {
        const seconds = String(Math.round(timeoutMs / 100) / 10);
        throw new Error("서버가 " + seconds + "초 안에 응답하지 않았습니다. 잠시 후 다시 조회하고, 계속되면 서버를 실행한 창의 기록(로그)을 확인하거나 강사에게 알려 주세요.");
      }
      throw new Error("서버 응답이 JSON 형식이 아닙니다. 연결 주소가 API 서버 주소인지 확인해 주세요.");
    }
    if (body && typeof body.error === "string") throw new Error(serverReasonMessage(body.error));
    return body;
  } finally {
    clearTimeout(timer);
  }
}

const RETRY_HINT = "잠시 후 다시 조회하고, 계속되면 서버를 실행한 창의 기록(로그)을 확인하거나 강사에게 알려 주세요.";

function httpErrorMessage(status) {
  if (status === 400) return "서버가 요청 조건을 받아들이지 않았습니다(HTTP 400).";
  if (status === 404) return "서버에 요청한 주소가 없습니다(HTTP 404). 연결 주소를 확인해 주세요.";
  if (status >= 500) return "서버가 요청을 처리하지 못했습니다(HTTP " + status + "). " + RETRY_HINT;
  return "서버가 요청을 거절했습니다(HTTP " + status + ").";
}

function serverReasonMessage(reason) {
  return "서버가 요청을 처리하지 못했습니다. 서버가 알린 이유: " + reason;
}

const TIME_TEXT = "시각 문자열(예: 2026-10-15T09:00:00+09:00)";
const fieldError = (lead, path, expected) => lead + " 틀린 항목: " + path + " (기대: " + expected + ")";
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

function validateSnapshot(data) {
  const base = (path, expected) => fieldError("서버 자료의 기본 형식을 확인해 주세요.", path, expected);
  if (!isObject(data)) return base("(응답 전체)", "JSON 객체");
  if (data.schemaVersion !== 1) return base("schemaVersion", "숫자 1");
  if (!integer(data.revision) || data.revision < 1) return base("revision", "1 이상의 정수");
  if (typeof data.scenarioId !== "string") return base("scenarioId", "문자열");
  if (!validTime(data.changedAt)) return base("changedAt", TIME_TEXT);
  if (!validTime(data.serverTime)) return base("serverTime", TIME_TEXT);
  if (data.trainingOnly !== true) return base("trainingOnly", "true");
  if (!isObject(data.sites)) return base("sites", "객체");
  if (!isObject(data.services)) return base("services", "객체");
  if (!Array.isArray(data.incidents)) return base("incidents", "배열");

  const serviceError = (path, expected) => fieldError("서비스 상태의 형식을 확인해 주세요.", path, expected);
  if (data.incidents.length > 0) {
    const incident = data.incidents[0];
    const path = "incidents[0]";
    if (!isObject(incident)) return serviceError(path, "객체");
    if (typeof incident.id !== "string") return serviceError(path + ".id", "문자열");
    if (!["warning", "error"].includes(incident.level)) return serviceError(path + ".level", "\"warning\" 또는 \"error\"");
    const missing = ["title", "owner", "action"].find(key => typeof incident[key] !== "string");
    if (missing) return serviceError(path + "." + missing, "문자열");
  }

  if (data.viewTime !== undefined && (!validTime(data.viewTime) || Date.parse(data.viewTime) > Date.parse(data.serverTime))) {
    return fieldError("조회 기준 시각을 확인해 주세요.", "viewTime", "serverTime 이전이거나 같은 " + TIME_TEXT);
  }
  return null;
}

function validateRecords(data, at) {
  const lead = "기록 응답 형식이 올바르지 않습니다.";
  if (!isObject(data)) return fieldError(lead, "(응답 전체)", "JSON 객체");
  if (!Array.isArray(data.records)) return fieldError(lead, "records", "배열");
  const limit = Date.parse(at);
  const before = "기준 시각 이전이거나 같은 " + TIME_TEXT;
  for (const [index, record] of data.records.entries()) {
    const path = "records[" + index + "]";
    if (!isObject(record)) return fieldError(lead, path, "객체");
    if (!integer(record.quantity)) return fieldError(lead, path + ".quantity", "0 이상의 정수");
    if (!validTime(record.occurredAt) || Date.parse(record.occurredAt) > limit) return fieldError(lead, path + ".occurredAt", before);
    for (const key of ["receivedAt", "processedAt"]) {
      if (record[key] !== null && (!validTime(record[key]) || Date.parse(record[key]) > limit)) {
        return fieldError(lead, path + "." + key, "null 또는 " + before);
      }
    }
  }
  return null;
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

async function readSnapshot(at = "") {
  if (typeof config.apiBaseUrl !== "string" || !/^https?:\/\//.test(config.apiBaseUrl)) {
    throw new Error("API 연결 주소가 설정되지 않았습니다.");
  }
  const params = at ? new URLSearchParams({ at: new Date(at).toISOString() }) : "";
  const response = await requestJson(apiUrl(config.apiBaseUrl, "/api/v1/snapshot", params));
  const problem = validateSnapshot(response);
  if (problem) throw new Error(problem);
  if (at && (!validTime(response.viewTime) || Date.parse(response.viewTime) !== Date.parse(at))) {
    throw new Error("요청한 기준 시각과 서버 자료의 시각이 다릅니다.");
  }
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

function currentIssues(data, failure = "") {
  const unique = new Map();
  for (const item of data?.incidents || []) {
    if (item.id !== "PREDICTION-JOB" && !unique.has(item.id)) {
      unique.set(item.id, item);
    }
  }
  if (failure) {
    unique.set("API-QUERY", {
      id: "API-QUERY",
      scope: "service",
      level: "error",
      title: "최신 자료를 가져오지 못했습니다.",
      owner: "서비스 운영 담당자",
      action: "조회 연결과 서버 상태를 확인해 주세요."
    });
  }
  return [...unique.values()].sort((a, b) => {
    const rank = item => item.id === "API-QUERY" ? 0 : item.level === "error" ? 1 : 2;
    return rank(a) - rank(b);
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
  } else if (first.id === "API-QUERY") {
    guidance = "새로고침 후에도 실패하면 담당자에게 문의하세요. ";
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

function checkRecordRange() {
  const from = document.querySelector("#record-from");
  const to = document.querySelector("#record-to");
  const fromTime = Date.parse(from.value + "+09:00");
  const toTime = Date.parse(to.value + "+09:00");
  to.setCustomValidity(toTime < fromTime ? "끝 시각은 시작 시각과 같거나 늦어야 합니다." : "");
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
let recordsData = null;
let recordsError = "";
let recordsLoading = false;
let recordsRequestKey = "";

function renderRecords(data, id, sameScreen) {
  const from = document.querySelector("#record-from");
  const to = document.querySelector("#record-to");
  const day = dayInSeoul(data.viewTime);
  const end = localDateTime(data.viewTime);
  from.min = to.min = day + "T00:00:00";
  from.max = to.max = end;
  if (document.activeElement !== from) from.value = day + "T00:00:00";
  if (document.activeElement !== to) to.value = end;
  checkRecordRange();

  const rows = recordsData && Array.isArray(recordsData.records) ? recordsData.records.map(record => [
    dateText(record.occurredAt),
    numberText(record.quantity) + "개",
    validTime(record.receivedAt) ? dateText(record.receivedAt) : "접수 대기",
    validTime(record.processedAt) ? dateText(record.processedAt) : "처리 대기",
    recordStatus(record.status)
  ]) : null;
  const result = document.querySelector("#records-result");
  const key = JSON.stringify([recordsError, rows ?? recordsLoading]);
  if (recordsView === key) {
    renderedRecordsHash = location.hash;
    return;
  }
  recordsView = key;
  keepScroll(result, () => {
    if (recordsError) {
      const notice = document.createElement("p");
      notice.className = "notice warning";
      notice.textContent = recordsError;
      result.replaceChildren(notice);
    } else if (!rows) {
      const notice = document.createElement("p");
      notice.className = "notice";
      notice.textContent = "기록을 확인하고 있습니다.";
      result.replaceChildren(notice);
    } else if (rows.length > 0) {
      result.replaceChildren(createRecordTable(["발생 시각", "수량", "서버 접수", "서버 처리", "상태"], rows));
    } else {
      const notice = document.createElement("p");
      notice.className = "notice";
      notice.textContent = "선택한 시간대에 기록이 없습니다.";
      result.replaceChildren(notice);
    }
  }, sameScreen && renderedRecordsHash === location.hash);
  renderedRecordsHash = location.hash;
}

function queryStatusHistory(id) {
  const card = document.createElement("section");
  card.className = "card query-history";
  card.setAttribute("aria-label", "조회 상태 이력");
  const label = record => !record.ok ? "조회 실패" : record.available[id] ? "자료 제공" : "현장 값 누락";
  const tone = record => !record.ok ? "danger" : record.available[id] ? "good" : "warning";
  const latest = queryLog[queryLog.length - 1];
  const top = document.createElement("div");
  top.className = "status-line";
  const title = document.createElement("h2");
  title.textContent = id === "factory" ? "생산 데이터 조회" : "출고 데이터 조회";
  const status = document.createElement("span");
  status.className = "history-status " + (latest ? tone(latest) : "neutral");
  status.textContent = latest ? label(latest) : "조회 기록 없음";
  top.append(title, status);
  card.append(top);

  if (!latest) {
    const empty = document.createElement("p");
    empty.className = "notice";
    empty.textContent = "아직 조회 기록이 없습니다.";
    card.append(empty);
    return card;
  }

  const strip = document.createElement("div");
  strip.className = "history-strip";
  strip.setAttribute("aria-label", "조회별 상태. 오래된 기록부터 최신 기록 순서입니다.");
  const detail = document.createElement("p");
  detail.className = "meta history-detail";
  detail.setAttribute("role", "status");
  detail.textContent = "막대 하나가 조회 한 번입니다. 막대를 선택하면 시각과 결과를 확인할 수 있습니다.";
  for (const record of queryLog) {
    const context = record.at ? dateText(record.at) : "현재";
    const description = dateText(record.requestedAt) + " · " + label(record) + " · " + record.durationMs + "ms · 기준 시각: " + context;
    const bar = document.createElement("button");
    bar.type = "button";
    bar.className = "history-bar " + tone(record);
    bar.title = description;
    bar.setAttribute("aria-label", description);
    bar.dataset.at = record.requestedAt;
    const choose = () => {
      queryPick = record.requestedAt;
      detail.textContent = description;
    };
    bar.addEventListener("click", choose);
    bar.addEventListener("focus", choose);
    if (record.requestedAt === queryPick) detail.textContent = description;
    strip.append(bar);
  }
  card.append(strip);

  const range = document.createElement("div");
  range.className = "history-range";
  const successRate = (queryLog.filter(record => record.ok).length / queryLog.length * 100).toFixed(1);
  const firstTime = document.createElement("span");
  firstTime.textContent = dateText(queryLog[0].requestedAt);
  const rate = document.createElement("strong");
  rate.textContent = "조회 성공률 " + successRate + "% · " + queryLog.length + "건";
  const latestTime = document.createElement("span");
  latestTime.textContent = dateText(latest.requestedAt);
  range.append(firstTime, rate, latestTime);
  card.append(range);

  const legend = document.createElement("p");
  legend.className = "meta";
  legend.textContent = "초록: 자료 제공 · 노랑: 조회 성공, 현장 값 누락 · 빨강: 조회 실패. 기록이 없는 기간의 가동률은 계산하지 않습니다.";
  card.append(legend, detail);
  return card;
}

function queriesContent(id) {
  const rows = [...queryLog].reverse().map(record => [
    dateText(record.requestedAt),
    record.at ? dateText(record.at) : "현재",
    record.ok ? "성공" : "실패",
    record.durationMs + "ms",
    !record.ok ? "확인 불가" : record.available[id] ? "제공" : "누락",
    record.error || "—"
  ]);
  const table = rows.length ? createRecordTable(
    ["요청 시각", "기준 시각", "조회 결과", "응답시간", "현장 값", "실패 이유"],
    rows
  ) : Object.assign(document.createElement("p"), {
    className: "notice",
    textContent: "조회 기록이 없습니다."
  });
  return [queryStatusHistory(id), table];
}

async function loadRecords(at, id) {
  const requestKey = id + "\n" + at;
  if (recordsLoading || recordsRequestKey === requestKey) return;
  recordsLoading = true;
  recordsRequestKey = requestKey;
  recordsError = "";

  const params = new URLSearchParams({
    kind: id === "factory" ? "production" : "shipment",
    at
  });
  try {
    const response = await requestJson(apiUrl(config.apiBaseUrl, "/api/v1/records", params));
    const problem = validateRecords(response, at);
    if (problem) throw new Error(problem);
    recordsData = response;
    recordsError = "";
  } catch (error) {
    recordsError = String(error?.message || error);
  } finally {
    recordsLoading = false;
    renderRecords(lastData, id, true);
  }
}

document.querySelector("#record-from").addEventListener("input", event => {
  recordFrom = event.currentTarget.value;
  checkRecordRange();
});
document.querySelector("#record-to").addEventListener("input", event => {
  recordTo = event.currentTarget.value;
  checkRecordRange();
});
document.querySelector("#record-filter").addEventListener("submit", event => {
  event.preventDefault();
  checkRecordRange();
  if (!document.querySelector("#record-filter").reportValidity()) return;
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
  document.querySelector("#page-content").setAttribute("aria-busy", String(!data && !errorText));
  renderDataError(data, errorText);
  updateViewControl();
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
  const focusedQueryAt = sameScreen && queriesView.contains(document.activeElement)
    ? document.activeElement.dataset?.at
    : "";
  if (!sameScreen) queryPick = "";
  const backLink = document.querySelector("#back-link");
  const routeNotice = document.querySelector("#route-notice");
  const issues = currentIssues(data, errorText);
  renderNotifications(issues);
  renderHero(issues);
  renderQuerySummary();

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
    keepScroll(queriesView, () => queriesView.replaceChildren(...queriesContent(route.id)), sameScreen);
    if (focusedQueryAt) {
      queriesView.querySelectorAll(".history-bar").forEach(bar => {
        if (bar.dataset.at === focusedQueryAt) bar.focus({ preventScroll: true });
      });
    }
  } else {
    pageTitle.textContent = "오늘 운영";
    pageDescription.textContent = "생산·출고 실적과 운영 상태를 살펴봅니다.";
  }

  const viewTime = Date.parse(data.viewTime);
  renderSite("factory", data.sites.factory, viewTime, data.services.alerts);
  renderSite("warehouse", data.sites.warehouse, viewTime, data.services.alerts);
  const recordsKey = route.view === "records" && lastData ? route.id + "\n" + lastData.viewTime : "";
  if (recordsKey && !recordsData && !recordsError && !recordsLoading && recordsRequestKey !== recordsKey) {
    loadRecords(lastData.viewTime, route.id);
  }
}

function localDay(value) {
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

function updateViewControl(rebuild = false) {
  const select = document.querySelector("#view-time");
  if (!rebuild && document.activeElement === select) return;

  const now = lastData?.serverTime || new Date().toISOString();
  const today = localDay(now);
  const options = [new Option("현재", "")];
  for (let hour = 0; hour < 24; hour++) {
    const value = new Date(today + "T" + String(hour).padStart(2, "0") + ":00:00+09:00").toISOString();
    if (Date.parse(value) > Date.parse(now)) break;
    options.push(new Option(String(hour).padStart(2, "0") + ":00", value));
  }

  const latestTime = lastData?.serverTime;
  for (const value of [latestTime, selectedAt].filter(Boolean)) {
    if (options.some(option => option.value === value) || localDay(value) !== today || Date.parse(value) > Date.parse(now)) continue;
    const label = localDateTime(value).slice(11, 16) + (value === latestTime ? " (최근 조회)" : "");
    options.push(new Option(label, value));
  }

  select.replaceChildren(...options);
  select.value = selectedAt;
}

function changeView(at) {
  selectedAt = at;
  viewGeneration++;
  lastData = null;
  lastSuccessAt = null;
  errorText = "";
  render();
  if (!polling) poll();
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
let queryLog = [];
let queryPick = "";
let leaving = false;
const QUERY_LOG_KEY = "tumble-query-log";
try {
  const stored = JSON.parse(sessionStorage.getItem(QUERY_LOG_KEY) || "[]");
  if (Array.isArray(stored)) {
    queryLog = stored.filter(record => record && validTime(record.requestedAt) && typeof record.ok === "boolean" &&
      integer(record.durationMs) && record.available && typeof record.available.factory === "boolean" &&
      typeof record.available.warehouse === "boolean").slice(-200);
  }
} catch {
  queryLog = [];
}

function saveQueryLog(entry) {
  queryLog.push(entry);
  queryLog = queryLog.slice(-200);
  try {
    sessionStorage.setItem(QUERY_LOG_KEY, JSON.stringify(queryLog));
  } catch {
    // sessionStorage를 사용할 수 없으면 메모리의 기록만 사용합니다.
  }
}

function renderQuerySummary() {
  const latest = queryLog[queryLog.length - 1];
  for (const site of ["factory", "warehouse"]) {
    const value = document.querySelector("#" + site + "-query");
    const meta = document.querySelector("#" + site + "-query-meta");
    if (!latest) {
      value.textContent = "조회 기록 없음";
      meta.hidden = true;
      meta.textContent = "";
      continue;
    }
    value.textContent = dateText(latest.requestedAt) + " · " + (latest.ok ? "조회 성공" : "조회 실패");
    meta.hidden = false;
    meta.textContent = latest.ok
      ? "응답시간: " + latest.durationMs + "ms · " + (latest.available[site] ? "현장 값 제공" : "현장 값 누락")
      : "자료를 받지 못했습니다.";
  }
}

function sitesAvailable(data) {
  return {
    factory: integer(data.sites.factory.completed) && integer(data.sites.factory.target),
    warehouse: integer(data.sites.warehouse.completed) && integer(data.sites.warehouse.target)
  };
}

const refreshButton = document.querySelector("#refresh-btn");
const countdownText = document.querySelector("#countdown-text");

function clearPollSchedule() {
  clearTimeout(pollTimer);
  pollTimer = null;
  nextPollAt = null;
}

function scheduleNextPoll() {
  clearPollSchedule();
  if (selectedAt) {
    updateCountdown();
    return;
  }
  nextPollAt = Date.now() + POLL_INTERVAL_MS;
  pollTimer = setTimeout(() => {
    clearPollSchedule();
    poll();
  }, POLL_INTERVAL_MS);
  updateCountdown();
}

function updateCountdown() {
  countdownText.hidden = !!selectedAt;
  if (selectedAt) return;
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
  const generation = viewGeneration;
  const startedAt = Date.now();
  const entry = {
    requestedAt: new Date(startedAt).toISOString(),
    at: selectedAt,
    ok: false,
    durationMs: 0,
    available: { factory: false, warehouse: false },
    error: ""
  };
  updateRefreshButton();
  try {
    const data = await readSnapshot(selectedAt);
    entry.ok = true;
    entry.available = sitesAvailable(data);
    if (generation !== viewGeneration) return;
    lastData = data;
    lastSuccessAt = new Date().toISOString();
    errorText = "";
    recordsData = null;
    recordsError = "";
    recordsRequestKey = "";
    render(data);
    const { view, id } = resolveRoute(location.hash);
    if (view === "records") loadRecords(data.viewTime, id);
  } catch (error) {
    const message = String(error?.message || error);
    entry.error = message;
    if (generation === viewGeneration) {
      if (!leaving) errorText = message;
      render(lastData);
    }
  } finally {
    entry.durationMs = Math.max(0, Date.now() - startedAt);
    if (entry.ok || !leaving) saveQueryLog(entry);
    polling = false;
    updateRefreshButton();
    if (generation !== viewGeneration) poll();
    else if (!selectedAt) scheduleNextPoll();
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
document.querySelector("#view-time").addEventListener("change", event => changeView(event.target.value));
const leaveTimeout = typeof config.timeoutMs === "number" ? config.timeoutMs : 5000;
for (const eventName of ["beforeunload", "pagehide"]) {
  window.addEventListener(eventName, () => {
    leaving = true;
    setTimeout(() => { leaving = false; }, leaveTimeout);
  });
}
window.addEventListener("pageshow", () => { leaving = false; });
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