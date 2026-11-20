import { BadRequestException, Injectable } from "@nestjs/common";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { businessDate, OperationRecord, seedRecords } from "./records";

type StoredState = {
  sessionId: string;
  records: OperationRecord[];
  scenarioId: string;
  revision: number;
  changedAt: string;
};

@Injectable()
export class StateService {
  private readonly path = resolve(process.env.STATE_FILE || "./var/state.json");
  private state: StoredState;

  constructor() {
    mkdirSync(dirname(this.path), { recursive: true });
    if (existsSync(this.path)) {
      this.state = JSON.parse(readFileSync(this.path, "utf8")) as StoredState;
      return;
    }

    const changedAt = new Date().toISOString();
    this.state = this.save({
      sessionId: "lesson-" + changedAt + "-1",
      records: seedRecords(changedAt),
      scenarioId: "normal",
      revision: 1,
      changedAt,
    });
  }

  records(kind: string, from?: string, to?: string, at?: string) {
    if (kind !== "production" && kind !== "shipment") {
      throw new BadRequestException("생산 또는 출고 기록을 선택해 주세요.");
    }

    const now = new Date().toISOString();
    const viewValue = at === undefined ? now : at;
    if (
      !viewValue ||
      !/^\d{4}-\d{2}-\d{2}T/.test(viewValue) ||
      !/(Z|[+-]\d{2}:\d{2})$/i.test(viewValue) ||
      !Number.isFinite(Date.parse(viewValue)) ||
      Date.parse(viewValue) > Date.parse(now) ||
      businessDate(viewValue) !== businessDate(now)
    ) {
      throw new BadRequestException("오늘의 현재 이전 시각을 선택해 주세요.");
    }

    const viewTime = new Date(viewValue).toISOString();
    const start = from || businessDate(viewTime) + "T00:00:00+09:00";
    const end = to || viewTime;
    const validBound = (value: string) =>
      /(Z|[+-]\d{2}:\d{2})$/i.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      businessDate(value) === businessDate(viewTime);
    if (
      !validBound(start) ||
      !validBound(end) ||
      Date.parse(start) > Date.parse(end) ||
      Date.parse(end) > Date.parse(viewTime)
    ) {
      throw new BadRequestException("조회 시간 구간을 확인해 주세요.");
    }

    const cutoff = Date.parse(viewTime);
    const records = this.state.records
      .filter(record =>
        record.kind === kind &&
        Date.parse(start) <= Date.parse(record.occurredAt) &&
        Date.parse(record.occurredAt) <= Date.parse(end)
      )
      .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
      .map(record => {
        const receivedAt = record.receivedAt && Date.parse(record.receivedAt) <= cutoff ? record.receivedAt : null;
        const processedAt = record.processedAt && Date.parse(record.processedAt) <= cutoff ? record.processedAt : null;
        const status = processedAt ? "completed" : receivedAt ? "processing-wait" : "receipt-wait";
        return { ...record, receivedAt, processedAt, status };
      });

    return { sessionId: this.state.sessionId, viewTime, records };
  }

  snapshot(at?: string) {
    const now = new Date().toISOString();
    const viewValue = at === undefined ? now : at;
    if (
      !viewValue ||
      !/^\d{4}-\d{2}-\d{2}T/.test(viewValue) ||
      !/(Z|[+-]\d{2}:\d{2})$/i.test(viewValue) ||
      !Number.isFinite(Date.parse(viewValue)) ||
      Date.parse(viewValue) > Date.parse(now) ||
      businessDate(viewValue) !== businessDate(now)
    ) {
      throw new BadRequestException("오늘의 현재 이전 시각을 선택해 주세요.");
    }

    const viewTime = new Date(viewValue).toISOString();
    const sites: Record<"factory" | "warehouse", Record<string, unknown>> = {
      factory: { label: "텀블공장", target: 120 },
      warehouse: { label: "물류창고", target: 100 },
    };
    const incidents: Array<{
      id: string;
      scope: string;
      level: "warning";
      title: string;
      owner: string;
      action: string;
    }> = [];

    for (const [id, kind] of [["factory", "production"], ["warehouse", "shipment"]] as const) {
      const site = sites[id];
      const rows = this.records(kind, undefined, undefined, viewTime).records;
      const total = this.state.records
        .filter(record => record.kind === kind && businessDate(record.occurredAt) === businessDate(viewTime) && record.processedAt && Date.parse(record.processedAt) <= Date.parse(viewTime))
        .reduce((sum, record) => sum + record.quantity, 0);
      const latest = rows[rows.length - 1];
      const completed = total || null;
      const lastEventAt = latest?.occurredAt || null;
      const receivedAt = latest?.receivedAt || null;
      const processedAt = latest?.processedAt || null;
      const processingState = latest?.processedAt ? "completed" : "waiting";
      const historyTotals = new Map<string, number>();

      for (const row of rows) {
        if (!row.processedAt) continue;
        const hour = new Date(Math.floor(Date.parse(row.occurredAt) / 3600000) * 3600000).toISOString();
        historyTotals.set(hour, (historyTotals.get(hour) || 0) + row.quantity);
      }
      const history = [...historyTotals]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([timestamp, quantity]) => ({ timestamp, quantity }));

      const image = {
        url: (process.env.PUBLIC_BASE_URL || "http://127.0.0.1:" + (process.env.PORT || "3000")).replace(/\/$/, "") + "/api/v1/images/" + id,
        alt: id === "factory" ? "생산 라인 참고 사진" : "물류창고 참고 사진",
      };
      const stale = lastEventAt !== null && Date.parse(viewTime) - Date.parse(lastEventAt) > 30 * 60 * 1000;
      const status = !latest || stale || processingState !== "completed" ? "warning" : "normal";
      const note = status === "normal"
        ? "기록이 반영되고 있습니다."
        : !latest
          ? site.label + "의 기록이 없습니다."
          : processingState !== "completed"
            ? site.label + " 기록 처리를 기다리고 있습니다."
            : site.label + " 기록이 30분 넘게 들어오지 않았습니다.";

      Object.assign(site, {
        completed,
        lastEventAt,
        receivedAt,
        processedAt,
        processingState,
        history,
        image,
        status,
        note,
      });

      if (status === "warning") {
        incidents.push({
          id: id === "factory" ? "FACTORY-FEED" : "WAREHOUSE-FEED",
          scope: id,
          level: "warning",
          title: note,
          owner: id === "factory" ? "공장 데이터 담당자" : "창고 데이터 담당자",
          action: "기록 수집과 처리 상태를 확인해 주세요.",
        });
      }
    }

    return {
      schemaVersion: 1,
      revision: this.state.revision,
      scenarioId: this.state.scenarioId,
      changedAt: this.state.changedAt,
      serverTime: now,
      viewTime,
      trainingOnly: true,
      sites,
      services: {
        alerts: {
          status: "sent",
          lastAttemptAt: new Date(Date.parse(this.state.changedAt) - 60000).toISOString(),
          note: "모의 전송 성공 기록입니다. 실제 알림을 보내지 않았습니다.",
        },
      },
      incidents,
    };
  }

  private save(next: StoredState): StoredState {
    const temporary = this.path + ".next";
    writeFileSync(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, this.path);
    return next;
  }
}