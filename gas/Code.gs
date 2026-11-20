var TUMBLE_SHEETS = {
  production: "생산 기록",
  shipment: "출고 기록",
  settings: "설정",
  alerts: "알림 기록"
};

var TUMBLE_HEADERS = ["기록 ID", "수량", "발생 시각", "접수 시각", "처리 시각", "처리 상태"];

function properties_() {
  return PropertiesService.getScriptProperties();
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function sendAlert_(key, message) {
  var props = properties_();
  var storageKey = "ALERT_" + meta_().sessionId + "_" + key;
  var now = Date.now();
  var last = Number(props.getProperty(storageKey) || 0);
  if (now - last < settings_().cooldown_minutes * 60000) return;

  var status = "failed";
  var detail = "알림 연결 또는 웹훅 설정을 확인해 주세요.";
  var url = props.getProperty("DISCORD_WEBHOOK_URL");
  var validUrl = typeof url === "string" && /^https:\/\/discord\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url);
  try {
    if (validUrl) {
      var content = message.indexOf("텀블공장: ") === 0 || message.indexOf("물류창고: ") === 0
        ? message
        : "텀블공장: " + message;
      var response = UrlFetchApp.fetch(url + "?wait=true", {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify({ content: content, allowed_mentions: { parse: [] } }),
        muteHttpExceptions: true
      });
      var code = response.getResponseCode();
      status = code >= 200 && code <= 299 ? "sent" : "failed";
      detail = "HTTP " + code;
    }
  } catch (error) {
    status = "failed";
    detail = "알림 연결 또는 웹훅 설정을 확인해 주세요.";
  } finally {
    var sheet = spreadsheet_().getSheetByName(TUMBLE_SHEETS.alerts);
    sheet.appendRow(toRow_([new Date(now).toISOString(), key, message, status, detail]));
    props.setProperty(storageKey, String(now));
  }
}

function testDiscordAlert() {
  withLock_(function () {
    sendAlert_("test-" + Utilities.getUuid(), "알림 연결 테스트입니다.");
  });
}

function spreadsheet_() {
  var id = properties_().getProperty("SPREADSHEET_ID");
  if (!id) throw Error("먼저 createTrainingSpreadsheet를 실행해 주세요.");
  return SpreadsheetApp.openById(id);
}

function toCell_(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && /^[0-9=+\-@]/.test(value)) return "'" + value;
  return value;
}

function toRow_(row) {
  return row.map(toCell_);
}

function fromCell_(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && /^'[0-9=+\-@]/.test(value)) return value.slice(1);
  return value;
}

function rows_(sheetName) {
  var sheet = spreadsheet_().getSheetByName(sheetName);
  if (!sheet) throw Error("시트 탭을 찾을 수 없습니다: " + sheetName);
  var values = sheet.getDataRange().getValues();
  return values.slice(1).map(function (row) { return row.map(fromCell_); });
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function readData_(at, kinds) {
  var now = new Date().toISOString();
  var cutoff = TumbleCore.view(at, now);
  var meta = meta_();
  var records = [];
  var errors = [];
  (kinds || ["production", "shipment"]).forEach(function (kind) {
    var name = TUMBLE_SHEETS[kind];
    var sheet = spreadsheet_().getSheetByName(name);
    var currentRows = rows_(name);
    var notes = sheet.getDataRange().getNotes().slice(1);
    var sourceRows = currentRows.map(function (row, index) {
      var cells = row.slice(0, 6);
      var note = notes[index] ? notes[index][0] : "";
      if (!note) {
        var unreceived = cells.slice();
        unreceived[3] = "";
        unreceived[4] = "";
        return unreceived;
      }
      var original = JSON.parse(note);
      var changed = cells.some(function (cell, cellIndex) {
        return String(cell) !== String(original[cellIndex]);
      });
      if (changed) {
        errors.push({
          sheet: name,
          row: index + 2,
          message: "접수한 기록의 수정은 반영하지 않습니다. 새 실습 시트를 만들어 주세요."
        });
      }
      return original;
    });
    var parsed = TumbleCore.parse(sourceRows, kind, now);
    records = records.concat(parsed.records);
    parsed.errors.forEach(function (error) {
      errors.push({ sheet: name, row: error.row, message: error.message });
    });
  });

  var settingsSheet = spreadsheet_().getSheetByName(TUMBLE_SHEETS.settings);
  var history = JSON.parse(settingsSheet.getRange("A1").getNote() || "[]");
  var entry = null;
  history.forEach(function (item) {
    if (Date.parse(item.at) <= Date.parse(cutoff)) entry = item;
  });
  if (!entry) throw Error("이 시점의 설정 자료가 없습니다.");

  return {
    now: now,
    at: cutoff,
    records: records,
    errors: errors,
    settings: entry.settings,
    meta: { sessionId: meta.sessionId, revision: entry.revision, changedAt: entry.at }
  };
}

function alerts_() {
  return rows_(TUMBLE_SHEETS.alerts)
    .filter(function (row) { return row[0] !== "" && row[0] !== null && row[0] !== undefined; })
    .map(function (row) {
      return { at: TumbleCore.iso(row[0]), status: row[3], message: row[2] };
    });
}

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    var path = (params.path === undefined || params.path === null ? "" : String(params.path))
      .replace(/^\/+|\/+$/g, "");
    var at = params.at;
    if (path === "api/v1/snapshot") {
      var data = readData_(at);
      var snapshotAt = at === undefined || at === null || at === "" ? null : at;
      return json_(TumbleCore.snapshot(
        data.records, data.settings, data.meta, alerts_(), snapshotAt, data.now, snapshotAt ? [] : data.errors
      ));
    }
    if (path === "api/v1/records") {
      var kind = params.kind;
      if (kind !== "production" && kind !== "shipment") {
        throw Error("생산 또는 출고 기록을 선택해 주세요.");
      }
      var picked = readData_(at, [kind]);
      return json_({
        sessionId: picked.meta.sessionId,
        viewTime: picked.at,
        records: TumbleCore.recordsAt(picked.records, kind, picked.at, params.from, params.to)
      });
    }
    throw Error("웹 앱 주소 뒤에 ?path=/api/v1/snapshot 또는 ?path=/api/v1/records를 붙여 주세요.");
  } catch (error) {
    return json_({ error: error.message });
  }
}

function settings_() {
  var settings = {};
  rows_(TUMBLE_SHEETS.settings).forEach(function (row, index) {
    var name = row[0];
    if (!name) return;
    var value = row[1];
    if (name === "factory_target" || name === "warehouse_target") {
      if (value === "" || value === null) {
        settings[name] = null;
      } else if (Number.isInteger(Number(value)) && Number(value) > 0) {
        settings[name] = Number(value);
      } else {
        throw Error("목표는 양의 정수 또는 빈칸입니다.");
      }
    } else if (name === "delay_minutes" || name === "cooldown_minutes") {
      var minutes = Number(value);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
        throw Error("대기 기준은 1~1440분입니다.");
      }
      settings[name] = minutes;
    } else if (name === "factory_paused" || name === "warehouse_paused") {
      if (value === true || value === "TRUE") {
        settings[name] = true;
      } else if (value === false || value === "FALSE") {
        settings[name] = false;
      } else {
        throw Error("처리 정지는 TRUE 또는 FALSE입니다.");
      }
    }
  });
  return settings;
}

function meta_() {
  var text = properties_().getProperty("TUMBLE_META");
  if (!text) throw Error("초기 자료가 없습니다.");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw Error("초기 자료가 없습니다.");
  }
}

// 6-7 설정 이력 남기기
function rememberSettings_() {
  var meta = meta_();
  var now = new Date().toISOString();
  meta.revision += 1;
  meta.changedAt = now;
  var cell = spreadsheet_().getSheetByName(TUMBLE_SHEETS.settings).getRange("A1");
  var history = JSON.parse(cell.getNote() || "[]");
  history.push({ at: now, settings: settings_(), revision: meta.revision });
  cell.setNote(JSON.stringify(history));
  properties_().setProperty("TUMBLE_META", JSON.stringify(meta));
}

// 기록 탭의 row행 하나를 접수·처리합니다. A칸 메모가 접수한 원본입니다.
function processRow_(sheet, row, notify) {
  var range = sheet.getRange(row, 1, 1, 6);
  var values = range.getValues()[0].map(fromCell_);
  var noteCell = sheet.getRange(row, 1);
  var note = noteCell.getNote();
  if (note) {
    var original = JSON.parse(note);
    // 처리를 마친 기록은 시트에서 고칠 수 없어 원본으로 되돌립니다.
    if (original[4]) {
      range.setValues([toRow_(original)]);
      return;
    }
    // 접수한 뒤에도 기록 ID·수량·발생 시각은 원본 값으로 고정합니다.
    values = original;
  } else {
    values[3] = "";
    values[4] = "";
  }
  var kind = sheet.getName() === TUMBLE_SHEETS.production ? "production" : "shipment";
  var now = new Date().toISOString();
  var id = String(values[0]);
  var duplicate = rows_(sheet.getName()).some(function (other, index) {
    return index + 2 !== row && String(other[0]) !== "" && String(other[0]) === id;
  });
  var parsed = TumbleCore.parse([values], kind, now);
  if (duplicate || parsed.errors.length) {
    sheet.getRange(row, 6).setValue("입력 확인 필요");
    if (notify) {
      sendAlert_("input-" + kind + "-" + row, duplicate ? "같은 기록 ID가 있습니다." : parsed.errors[0].message);
    }
    return;
  }
  if (!parsed.records.length) return;
  if (!values[3]) values[3] = now;
  var paused = settings_()[kind === "production" ? "factory_paused" : "warehouse_paused"];
  values[4] = paused ? "" : now;
  values[5] = paused ? "처리 대기" : "완료";
  range.setValues([toRow_(values)]);
  noteCell.setNote(JSON.stringify(values));
}

// 편집기에서 실행해 두 기록 탭의 모든 행을 접수·처리합니다.
function processPendingRecords() {
  withLock_(function () {
    [TUMBLE_SHEETS.production, TUMBLE_SHEETS.shipment].forEach(function (name) {
      var sheet = spreadsheet_().getSheetByName(name);
      for (var row = 2; row <= sheet.getLastRow(); row++) {
        processRow_(sheet, row, true);
      }
    });
    rememberSettings_();
  });
}

// 편집기에서 실행해 생산 기록 한 행(수량 10)을 더하고 바로 처리합니다.
function addDemoProductionRecord() {
  withLock_(function () {
    var sheet = spreadsheet_().getSheetByName(TUMBLE_SHEETS.production);
    sheet.appendRow(toRow_(["P-" + Utilities.getUuid(), 10, new Date().toISOString(), "", "", "대기"]));
    processRow_(sheet, sheet.getLastRow(), true);
    rememberSettings_();
  });
}


// 설치형 편집 트리거가 부릅니다. 실습 시트를 고치면 설정은 이력에 남기고, 기록 행은 바로 접수·처리합니다.
function onEditInstalled(e) {
  if (!e || !e.range || e.source.getId() !== properties_().getProperty("SPREADSHEET_ID")) return;
  withLock_(function () {
    var sheet = e.range.getSheet();
    var name = sheet.getName();
    if (name === TUMBLE_SHEETS.settings) {
      rememberSettings_();
      return;
    }
    if ((name !== TUMBLE_SHEETS.production && name !== TUMBLE_SHEETS.shipment) || e.range.getRow() === 1) return;
    for (var row = e.range.getRow(); row <= e.range.getLastRow(); row++) {
      processRow_(sheet, row, true);
    }
    rememberSettings_();
  });
}

// 시간 트리거가 1분마다 부릅니다. 현장 사건마다 알림을 보냅니다(같은 사건은 cooldown_minutes분 안에 다시 보내지 않습니다).
function checkRecordDelays() {
  withLock_(function () {
    var data = readData_();
    var snapshot = TumbleCore.snapshot(data.records, data.settings, data.meta, alerts_(), null, data.now, data.errors);
    snapshot.incidents.forEach(function (incident) {
      if (incident.scope !== "service") sendAlert_(incident.id, alertMessage_(incident));
    });
  });
}

// 편집기에서 실행해 두 트리거를 새로 만듭니다. 여러 번 실행해도 두 개만 남습니다.
function installTrainingTriggers() {
  var id = properties_().getProperty("SPREADSHEET_ID");
  if (!id) throw Error("시트를 먼저 생성해 주세요.");
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    var handler = trigger.getHandlerFunction();
    if (handler === "onEditInstalled" || handler === "checkRecordDelays") ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger("onEditInstalled").forSpreadsheet(id).onEdit().create();
  ScriptApp.newTrigger("checkRecordDelays").timeBased().everyMinutes(1).create();
}
