// 편집기에서 실행하면 새 실습 Google 시트와 시드 기록을 만듭니다.
function createTrainingSpreadsheet() {
  var now = Date.now();
  var nowIso = new Date(now).toISOString();
  var midnight = Date.parse(TumbleCore.day(nowIso) + "T00:00:00+09:00");
  var file = SpreadsheetApp.create("텀블공장 개인 실습 " + nowIso);
  file.setSpreadsheetTimeZone("Asia/Seoul");

  var production = file.getSheets()[0].setName(TUMBLE_SHEETS.production);
  var shipment = file.insertSheet(TUMBLE_SHEETS.shipment);
  var settingsSheet = file.insertSheet(TUMBLE_SHEETS.settings);
  var alertsSheet = file.insertSheet(TUMBLE_SHEETS.alerts);

  [[production, "P-seed-", 20], [shipment, "S-seed-", 15]].forEach(function (seed) {
    var sheet = seed[0];
    sheet.getRange(1, 1, 1, TUMBLE_HEADERS.length).setValues([TUMBLE_HEADERS]);
    var rows = [];
    var originals = [];
    for (var i = 0; i < 5; i++) {
      var occurredAt = midnight + Math.floor((now - midnight) * (i + 1) / 5);
      var occurredIso = new Date(occurredAt).toISOString();
      var gap = Math.min(2000, Math.floor((now - occurredAt) / 2));
      var receivedIso = new Date(occurredAt + gap).toISOString();
      var processedIso = new Date(Math.min(now, occurredAt + gap * 2)).toISOString();
      var original = [
        seed[1] + i,
        seed[2],
        occurredIso,
        receivedIso,
        processedIso,
        "완료"
      ];
      originals.push(original);
      rows.push(toRow_(original));
    }
    sheet.getRange(2, 1, rows.length, TUMBLE_HEADERS.length).setValues(rows);
    originals.forEach(function (row, index) {
      sheet.getRange(index + 2, 1).setNote(JSON.stringify(row));
    });
  });

  var settings = {
    factory_target: 120,
    warehouse_target: 100,
    delay_minutes: 30,
    cooldown_minutes: 10,
    factory_paused: false,
    warehouse_paused: false
  };
  var settingsRows = [["설정 이름", "값"]];
  Object.keys(settings).forEach(function (key) {
    settingsRows.push([key, settings[key]]);
  });
  settingsSheet.getRange(1, 1, settingsRows.length, 2).setValues(settingsRows);
  settingsSheet.getRange("A1").setNote(JSON.stringify([{
    at: new Date(midnight).toISOString(),
    revision: 1,
    settings: settings
  }]));

  alertsSheet.getRange(1, 1, 1, 5).setValues([["시각", "사건 ID", "내용", "발송 상태", "상세"]]);

  [production, shipment, settingsSheet, alertsSheet].forEach(function (sheet) {
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, sheet.getLastColumn());
  });

  var properties = properties_();
  properties.setProperty("SPREADSHEET_ID", file.getId());
  var meta = {
    sessionId: "lesson-" + nowIso + "-1",
    revision: 1,
    changedAt: nowIso
  };
  properties.setProperty("TUMBLE_META", JSON.stringify(meta));

  var url = file.getUrl();
  Logger.log("새 실습 시트: " + url);
  return url;
}