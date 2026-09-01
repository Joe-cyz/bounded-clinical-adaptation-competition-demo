import { describe, expect, it } from "vitest";

import { syntheticMedicalRecords } from "@/data/seed-loader";
import { createManualSyntheticInitialRecord } from "@/domain/manual-synthetic-record";
import type { SpeechSessionStatus } from "@/domain/speech";

import { SpeechWorkflowController, speechFailureReasonText } from "./speech-workflow-controller";

function createController(
  flow: "review" | "failed" | "cancelled" | "transcribing" = "review",
  onRecordChange: (record: typeof syntheticMedicalRecords[number]) => void = () => undefined,
): SpeechWorkflowController {
  return new SpeechWorkflowController({
    encounterId: "encounter-pwr5-controller-001",
    initialRecord: syntheticMedicalRecords[0],
    fixture: { flow },
    onRecordChange,
  });
}

async function waitForStatus(controller: SpeechWorkflowController, status: SpeechSessionStatus): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.snapshot().session?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${status}.`);
}

describe("SpeechWorkflowController", () => {
  it("maps controlled speech failure reasons to safe physician-facing messages", () => {
    expect(speechFailureReasonText("SPEECH_RECORDING_TOO_SHORT")).toBe("录音太短，请连续说话 2–10 秒。");
    expect(speechFailureReasonText("SPEECH_NO_AUDIO_DETECTED")).toBe("未检测到声音，请检查麦克风后重试。");
    expect(speechFailureReasonText("SPEECH_BROWSER_AUDIO_FAILED")).toBe("浏览器未能处理录音，请重新录制。");
    expect(speechFailureReasonText("SPEECH_LOCAL_SERVICE_UNAVAILABLE")).toBe("本地语音服务不可用，请重新启动演示。");
    expect(speechFailureReasonText("SPEECH_LOCAL_TRANSCRIPTION_FAILED")).toBe("本地转写未完成，可重试一次或手动录入。");
    expect(speechFailureReasonText()).toBe("语音转写失败，原病历内容未改变，仍可手动录入。");
    expect(speechFailureReasonText("UNCONTROLLED" as never)).toBe("语音转写失败，原病历内容未改变，仍可手动录入。");
  });

  it("runs the page test flow through the fake port, application service and audit sink", async () => {
    const changedRecords: Array<typeof syntheticMedicalRecords[number]> = [];
    const controller = createController("review", (record) => changedRecords.push(record));
    const originalRecord = JSON.stringify(syntheticMedicalRecords[0]);

    await controller.initialize();

    const reviewed = controller.snapshot().session;
    expect(reviewed?.status).toBe("NEEDS_REVIEW");
    expect(reviewed?.suggestions).toHaveLength(2);
    expect(reviewed?.suggestions.every((suggestion) => suggestion.decision === "PENDING")).toBe(true);
    expect(JSON.stringify(syntheticMedicalRecords[0])).toBe(originalRecord);
    expect(controller.audit.map((event) => event.afterStatus)).toEqual([
      "PERMISSION_REQUIRED",
      "RECORDING",
      "TRANSCRIBING",
      "NEEDS_REVIEW",
    ]);
    expect(controller.audit.every((event) => !JSON.stringify(event.metadata).includes("晨起乏力"))).toBe(true);

    const firstSuggestion = reviewed!.suggestions[0];
    controller.decideSuggestion(firstSuggestion.id, "ACCEPTED", "presentIllness");
    expect(changedRecords).toHaveLength(1);
    expect(changedRecords[0].history.presentIllness.value).toContain(firstSuggestion.text);
    expect(controller.snapshot().session?.status).toBe("PARTIALLY_ACCEPTED");

    controller.decideSuggestion(firstSuggestion.id, "IGNORED");
    expect(controller.snapshot().error).toBe("这条语音建议已经处理过。 ");
    expect(changedRecords).toHaveLength(1);

    await controller.ignorePendingAndContinue();
    expect(controller.snapshot().session?.status).toBe("ACCEPTED");
    expect(controller.audit.every((event) => !JSON.stringify(event.metadata).includes("recordPayload"))).toBe(true);
  });

  it("keeps the original record unchanged on provider failure and cancellation", async () => {
    const originalRecord = JSON.stringify(syntheticMedicalRecords[0]);
    const failed = createController("failed");
    await failed.initialize();
    expect(failed.snapshot().session?.status).toBe("FAILED");
    expect(JSON.stringify(syntheticMedicalRecords[0])).toBe(originalRecord);

    const cancelled = createController("cancelled");
    await cancelled.initialize();
    expect(cancelled.snapshot().session?.status).toBe("CANCELLED");
    expect(JSON.stringify(syntheticMedicalRecords[0])).toBe(originalRecord);
  });

  it("uses the visible suggestion draft for validation and writes only the latest valid text", async () => {
    const changedRecords: Array<typeof syntheticMedicalRecords[number]> = [];
    const controller = createController("review", (record) => changedRecords.push(record));
    await controller.initialize();
    const suggestion = controller.snapshot().session!.suggestions[0];
    const originalText = suggestion.text;

    controller.editSuggestion(suggestion.id, "");
    controller.decideSuggestion(suggestion.id, "ACCEPTED");
    expect(controller.snapshot().session?.suggestions[0].decision).toBe("PENDING");
    expect(controller.snapshot().draftTexts[suggestion.id]).toBe("");
    expect(changedRecords).toHaveLength(0);

    controller.editSuggestion(suggestion.id, "姓名：合成患者", "presentIllness");
    controller.decideSuggestion(suggestion.id, "ACCEPTED", "presentIllness");
    expect(controller.snapshot().session?.suggestions[0].decision).toBe("PENDING");
    expect(changedRecords).toHaveLength(0);

    controller.editSuggestion(suggestion.id, "x".repeat(2_001), "presentIllness");
    controller.decideSuggestion(suggestion.id, "ACCEPTED", "presentIllness");
    expect(controller.snapshot().session?.suggestions[0].decision).toBe("PENDING");
    expect(changedRecords).toHaveLength(0);

    const latestText = "医生确认后的最新合成口述";
    controller.editSuggestion(suggestion.id, latestText, "presentIllness");
    controller.decideSuggestion(suggestion.id, "ACCEPTED", "presentIllness");

    expect(changedRecords).toHaveLength(1);
    expect(changedRecords[0].history.presentIllness.value).toContain(latestText);
    expect(changedRecords[0].history.presentIllness.value).not.toContain(originalText);
    expect(changedRecords[0].history.presentIllness.value).not.toContain("姓名：合成患者");
    expect(changedRecords[0].history.presentIllness.value).not.toContain("x".repeat(2_001));
    expect(controller.audit.filter((event) => event.eventType === "SPEECH_SUGGESTIONS_PROCESSED")).toHaveLength(1);
    expect(controller.audit.at(-1)?.metadata.acceptedSuggestionCount).toBe(1);
  });

  it("keeps an unselected target empty until the physician explicitly chooses one", async () => {
    const changedRecords: Array<typeof syntheticMedicalRecords[number]> = [];
    const controller = createController("review", (record) => changedRecords.push(record));
    await controller.initialize();
    const suggestion = controller.snapshot().session!.suggestions[0];

    controller.updateAssignment(false);
    expect(controller.snapshot().autoAssignHistory).toBe(false);
    expect(controller.snapshot().selectedTarget).toBeUndefined();
    expect(controller.snapshot().session?.suggestions[0].target).toBeUndefined();

    controller.decideSuggestion(suggestion.id, "ACCEPTED");
    expect(controller.snapshot().error).toContain("请先选择归入栏目");
    expect(controller.snapshot().session?.suggestions[0].decision).toBe("PENDING");
    expect(changedRecords).toHaveLength(0);

    const latestText = "医生明确记录的主诉";
    controller.editSuggestion(suggestion.id, latestText, "chiefComplaint");
    controller.decideSuggestion(suggestion.id, "ACCEPTED", "chiefComplaint");
    expect(changedRecords).toHaveLength(1);
    expect(changedRecords[0].history.chiefComplaint.value).toContain(latestText);
    expect(changedRecords[0].history.presentIllness.value).not.toContain(latestText);
  });

  it("only reassigns pending suggestions when automatic history assignment is restored", async () => {
    const controller = createController("review");
    await controller.initialize();
    const first = controller.snapshot().session!.suggestions[0];

    controller.decideSuggestion(first.id, "ACCEPTED", "chiefComplaint");
    controller.updateAssignment(false);
    expect(controller.snapshot().session?.suggestions[0].target).toBe("chiefComplaint");
    expect(controller.snapshot().session?.suggestions[1].target).toBeUndefined();

    controller.updateAssignment(true);
    expect(controller.snapshot().session?.suggestions[0].target).toBe("chiefComplaint");
    expect(controller.snapshot().session?.suggestions[1].target).toBe("presentIllness");
  });

  it("uses the same in-memory workflow for a manual synthetic record without changing its source", async () => {
    const manualRecord = createManualSyntheticInitialRecord({
      intake: {
        schemaVersion: "1.0.0",
        intakeId: "manual-intake-pwr06b-test001",
        creationRequestId: "manual-request-pwr06b-test001",
        synthetic: true,
        displayLabel: "合成手工患者-pwr06b-test001",
        specialty: "普通内科",
        visitType: "初诊",
        sex: "FEMALE",
        age: 30,
        visitDate: "2026-08-24",
        recordDate: "2026-08-24",
        createdAt: "2026-08-24T00:00:00.000Z",
      },
      caseId: "manual-synthetic-case-pwr06b-test001",
      caseVersion: "manual-intake-1.0.0",
    });
    const sourceBefore = JSON.stringify(manualRecord.source);
    const changed: typeof manualRecord[] = [];
    const controller = new SpeechWorkflowController({
      encounterId: "manual-encounter-pwr06b-test001",
      initialRecord: manualRecord,
      fixture: { flow: "review" },
      onRecordChange: (record) => {
        if ("source" in record && record.source.type === "MANUAL_SYNTHETIC") changed.push(record);
      },
    });

    await controller.initialize();
    const suggestion = controller.snapshot().session!.suggestions[0];
    controller.decideSuggestion(suggestion.id, "ACCEPTED", "presentIllness");

    expect(changed).toHaveLength(1);
    expect(JSON.stringify(changed[0].source)).toBe(sourceBefore);
    expect(changed[0].history.presentIllness.status).toBe("PENDING_PHYSICIAN_CONFIRMATION");
    expect(changed[0].history.presentIllness.value).toContain(suggestion.text);
  });

  it("allows cancellation during transcription and ignores late provider results", async () => {
    const originalRecord = JSON.stringify(syntheticMedicalRecords[0]);
    const controller = createController("transcribing");
    const initialization = controller.initialize();
    await waitForStatus(controller, "TRANSCRIBING");
    expect(controller.hasTemporaryAudio).toBe(true);

    await controller.cancelRecording();
    expect(controller.snapshot().session?.status).toBe("CANCELLED");
    expect(controller.hasTemporaryAudio).toBe(false);
    await initialization;

    expect(controller.snapshot().session?.status).toBe("CANCELLED");
    expect(controller.snapshot().session?.suggestions).toHaveLength(0);
    expect(JSON.stringify(syntheticMedicalRecords[0])).toBe(originalRecord);
    expect(controller.audit.map((event) => event.afterStatus)).toEqual([
      "PERMISSION_REQUIRED",
      "RECORDING",
      "TRANSCRIBING",
      "CANCELLED",
    ]);

    const cancelledSessionId = controller.snapshot().session?.id;
    await controller.retryRecording();
    expect(controller.snapshot().session?.status).toBe("PERMISSION_REQUIRED");
    expect(controller.snapshot().session?.id).not.toBe(cancelledSessionId);
  });
});
