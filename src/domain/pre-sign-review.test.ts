import { describe, expect, it } from "vitest";

import { syntheticMedicalRecords } from "@/data/seed-loader";
import {
  applyReviewDecisions,
  createPreSignReview,
  evaluatePreSignReview,
  formatReviewItemTitle,
  formatReviewLocalTimestamp,
  parseReviewItemDecision,
  preSignReviewSchema,
} from "./pre-sign-review";
import {
  auxiliaryExamsSchema,
  medicalListFieldSchema,
  medicalTextFieldSchema,
  vitalSignsFieldSchema,
  type EncounterRecordV1,
} from "./medical-record";

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readyRecord(): EncounterRecordV1 {
  const record = copy(syntheticMedicalRecords[0]);
  const text = (value: string) => medicalTextFieldSchema.parse({ status: "PROVIDED", value });
  const list = (...items: string[]) => medicalListFieldSchema.parse({ status: "PROVIDED", items });
  record.history = {
    chiefComplaint: text("合成主诉"),
    presentIllness: text("合成现病史"),
    problemFacts: list("合成事实"),
    recentChanges: list("合成变化"),
    pastHistory: text("无特殊既往史"),
    personalHistory: text("合成个人史"),
    familyHistory: text("无特殊家族史"),
    allergyHistory: text("无已知过敏"),
    currentMedications: text("无长期用药"),
    redFlags: list("已核实无当前危险信号"),
  };
  record.physicalExam = {
    vitalSigns: vitalSignsFieldSchema.parse({ status: "PROVIDED", value: { temperatureC: 36.5 } }),
    generalCondition: text("一般情况稳定"),
    specialtyExam: text("专科检查已记录"),
    notExaminedOrUnknown: medicalListFieldSchema.parse({ status: "NOT_APPLICABLE" }),
  };
  record.auxiliaryExams = auxiliaryExamsSchema.parse({
    laboratory: { status: "NOT_APPLICABLE" },
    electrocardiogram: { status: "NOT_APPLICABLE" },
    imaging: { status: "NOT_APPLICABLE" },
    other: { status: "NOT_APPLICABLE" },
  });
  record.missingInformation = medicalListFieldSchema.parse({ status: "NOT_APPLICABLE" });
  record.pendingInformation = [];
  record.patientEducationFacts = list("已提供合成教育事实");
  return record;
}

describe("PWR-09 deterministic pre-sign review rules", () => {
  it("maps required statuses to blocking items and explicit not-applicable to no item", () => {
    const record = readyRecord();
    record.history.chiefComplaint = medicalTextFieldSchema.parse({ status: "UNKNOWN" });
    record.history.allergyHistory = medicalTextFieldSchema.parse({ status: "PENDING_PHYSICIAN_CONFIRMATION", value: "待核对的合成过敏信息" });
    record.history.currentMedications = medicalTextFieldSchema.parse({ status: "UNKNOWN" });
    record.history.redFlags = medicalListFieldSchema.parse({ status: "UNKNOWN" });
    record.auxiliaryExams.laboratory = { status: "PENDING_PHYSICIAN_CONFIRMATION", result: "合成结果" };

    const items = evaluatePreSignReview(record);
    expect(items.filter((item) => item.blocking).map((item) => item.ruleId)).toEqual(expect.arrayContaining([
      "CHIEF_COMPLAINT_REQUIRED",
      "ALLERGY_STATUS_REQUIRED",
      "CURRENT_MEDICATIONS_STATUS_REQUIRED",
      "RED_FLAGS_VERIFICATION_REQUIRED",
      "AUXILIARY_EXAMS_STATUS_REQUIRED",
    ]));
    expect(items.some((item) => item.ruleId === "PRESENT_ILLNESS_REQUIRED")).toBe(false);

    record.history.chiefComplaint = medicalTextFieldSchema.parse({ status: "NOT_APPLICABLE" });
    record.history.allergyHistory = medicalTextFieldSchema.parse({ status: "NOT_APPLICABLE" });
    record.history.currentMedications = medicalTextFieldSchema.parse({ status: "NOT_APPLICABLE" });
    record.history.redFlags = medicalListFieldSchema.parse({ status: "NOT_APPLICABLE" });
    record.auxiliaryExams.laboratory = { status: "NOT_APPLICABLE" };
    expect(evaluatePreSignReview(record).filter((item) => item.blocking)).toHaveLength(1);
    expect(evaluatePreSignReview(record).find((item) => item.ruleId === "CHIEF_COMPLAINT_REQUIRED")).toBeDefined();
  });

  it("creates contradiction blockers only from explicit structured pending information", () => {
    const record = readyRecord();
    record.history.presentIllness = medicalTextFieldSchema.parse({
      status: "PROVIDED",
      value: "自由文本提到可能矛盾和转诊，但不能由规则推断。",
    });
    expect(evaluatePreSignReview(record).some((item) => item.ruleId === "PENDING_INFORMATION_CONTRADICTION")).toBe(false);

    record.pendingInformation = [{
      id: "missing-general-first-001-01",
      category: "CONTRADICTION",
      status: "PENDING_PHYSICIAN_CONFIRMATION",
      description: "两条合成结构化记录待核对",
    }];
    const items = evaluatePreSignReview(record);
    expect(items.filter((item) => item.ruleId === "PENDING_INFORMATION_CONTRADICTION")).toHaveLength(1);
    expect(items.find((item) => item.ruleId === "PENDING_INFORMATION_CONTRADICTION")?.blocking).toBe(true);
    expect(items.some((item) => item.title.includes("转诊"))).toBe(false);
  });

  it("keeps literature review items empty and supports immutable decisions for non-blocking items", () => {
    const record = readyRecord();
    record.history.pastHistory = medicalTextFieldSchema.parse({ status: "UNKNOWN" });
    const review = createPreSignReview({
      id: "review-domain-001",
      encounterId: "encounter-domain-001",
      recordRevisionId: "record-revision-domain-001",
      revisionNumber: 1,
      record,
      createdAt: "2026-08-21T00:00:01.000Z",
    });
    const item = review.items.find((candidate) => !candidate.blocking);
    expect(item).toBeDefined();
    expect(review.items.some((candidate) => candidate.category === "PATIENT_EDUCATION" && candidate.title.includes("文献"))).toBe(false);

    const decision = parseReviewItemDecision({
      schemaVersion: "1.0.0",
      id: "decision-domain-001",
      reviewId: review.id,
      itemId: item?.id,
      decision: "CHECKED",
      actorId: "physician",
      simulatedRole: "PHYSICIAN",
      createdAt: "2026-08-21T00:00:02.000Z",
    });
    const applied = applyReviewDecisions(review, [decision]);
    expect(applied.items.find((candidate) => candidate.id === item?.id)?.status).toBe("CHECKED");
    expect(() => preSignReviewSchema.parse({ ...review, unexpected: true })).toThrow();
  });

  it("rejects PII in a not-applicable reason without echoing the value", () => {
    let error: unknown;
    try {
      parseReviewItemDecision({
        schemaVersion: "1.0.0",
        id: "decision-domain-002",
        reviewId: "review-domain-001",
        itemId: "review-item-optional-history-review-pasthistory",
        decision: "NOT_APPLICABLE",
        reason: "姓名：合成患者",
        actorId: "physician",
        simulatedRole: "PHYSICIAN",
        createdAt: "2026-08-21T00:00:02.000Z",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeDefined();
    expect(String(error)).not.toContain("合成患者");
  });

  it("formats structured review titles, pending-information ordinals, and Shanghai confirmation time", () => {
    const record = readyRecord();
    record.history.pastHistory = medicalTextFieldSchema.parse({ status: "UNKNOWN" });
    record.history.personalHistory = medicalTextFieldSchema.parse({ status: "UNKNOWN" });
    record.history.familyHistory = medicalTextFieldSchema.parse({ status: "UNKNOWN" });
    record.history.problemFacts = medicalListFieldSchema.parse({ status: "UNKNOWN" });
    record.history.recentChanges = medicalListFieldSchema.parse({ status: "UNKNOWN" });
    record.physicalExam.generalCondition = medicalTextFieldSchema.parse({ status: "UNKNOWN" });
    record.physicalExam.specialtyExam = medicalTextFieldSchema.parse({ status: "UNKNOWN" });
    record.physicalExam.notExaminedOrUnknown = medicalListFieldSchema.parse({ status: "UNKNOWN" });
    record.physicalExam.vitalSigns = vitalSignsFieldSchema.parse({ status: "UNKNOWN" });
    record.missingInformation = medicalListFieldSchema.parse({ status: "UNKNOWN" });
    record.patientEducationFacts = medicalListFieldSchema.parse({ status: "UNKNOWN" });
    record.pendingInformation = [
      { id: "missing-asked-001", category: "NOT_ASKED", status: "PENDING_PHYSICIAN_CONFIRMATION", description: "合成待询问信息一" },
      { id: "missing-asked-002", category: "NOT_ASKED", status: "PENDING_PHYSICIAN_CONFIRMATION", description: "合成待询问信息二" },
      { id: "missing-follow-up-001", category: "PHYSICIAN_FOLLOW_UP", status: "PENDING_PHYSICIAN_CONFIRMATION", description: "合成随访信息" },
    ];

    const items = evaluatePreSignReview(record);
    const totalByEvidenceCode = new Map<string, number>();
    for (const item of items) {
      if (item.source === "PENDING_INFORMATION") {
        totalByEvidenceCode.set(item.evidenceCode, (totalByEvidenceCode.get(item.evidenceCode) ?? 0) + 1);
      }
    }
    const occurrenceByEvidenceCode = new Map<string, number>();
    const titles = items.map((item) => {
      const key = item.source === "PENDING_INFORMATION" ? item.evidenceCode : item.id;
      const occurrence = (occurrenceByEvidenceCode.get(key) ?? 0) + 1;
      occurrenceByEvidenceCode.set(key, occurrence);
      return formatReviewItemTitle(item, occurrence, totalByEvidenceCode.get(key) ?? 1);
    });

    expect(titles).toEqual(expect.arrayContaining([
      "既往史未记录",
      "个人史未记录",
      "家族史未记录",
      "问题事实未核对",
      "近期变化未核对",
      "一般情况未记录",
      "专科体格检查未记录",
      "未检查项目未核对",
      "生命体征未记录",
      "患者教育待核对",
      "尚未询问的信息（1）",
      "尚未询问的信息（2）",
      "随访信息待核对",
    ]));
    expect(titles).not.toContain("非必填病史仍未记录");
    expect(titles).not.toContain("有一项待补充信息");
    expect(formatReviewLocalTimestamp("2026-08-22T03:36:00.000Z")).toBe("2026年8月22日 11:36");
  });
});
