function readRecordRows_(sheet) {
  return sheet.getDataRange().getValues().slice(1);
}

function sumQuantities_(records) {
  return records.reduce((sum, record) => sum + record.quantity, 0);
}

function groupHourly_(records) {
  return records.reduce((groups, record) => {
    const hour = new Date(Math.floor(Date.parse(record.occurredAt) / 3600000) * 3600000).toISOString();
    groups[hour] = (groups[hour] || 0) + record.quantity;
    return groups;
  }, {});
}

function isDelayed_(latest, at, minutes) {
  return Boolean(latest) && Date.parse(at) - Date.parse(latest.occurredAt) > minutes * 60000;
}

function alertMessage_(incident) {
  return incident.title + " 담당자: " + incident.owner + " / 할 일: " + incident.action;
}