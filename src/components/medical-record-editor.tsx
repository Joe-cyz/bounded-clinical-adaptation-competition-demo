"use client";

import Link from "next/link";
import { useActionState, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type TextareaHTMLAttributes } from "react";

import type {
  MedicalFieldStatus,
  MedicalListField,
  MedicalTextField,
} from "@/domain/medical-record";
import type { EncounterRecordPayload } from "@/domain/manual-synthetic-record";
import { editableMedicalRecordPayloadOf } from "@/domain/medical-record-editing";
import type { EncounterRecord, EncounterStatus } from "@/domain/encounter";
import type { SpeechCapability } from "@/domain/speech";

import {
  saveMedicalRecordAction,
  transitionToReferenceAction,
  type SaveMedicalRecordActionState,
  type TransitionReferenceActionState,
} from "@/app/encounters/actions";

import styles from "./medical-record-editor.module.css";
import { SpeechPanel } from "./speech-panel";
import { useSpeechWorkflow, type SpeechPanelTestFixture } from "./speech-workflow-controller";

type EditorMode = "public-demo" | "local-research";

export type MedicalRecordEditorView = {
  mode: EditorMode;
  encounterId: string;
  patientDisplayName: string;
  encounter?: EncounterRecord;
  record: EncounterRecordPayload;
  revisionId?: string;
  revisionNumber: number;
  expectedUpdatedAt: string;
  readOnly: boolean;
};

type HistoryTextKey =
  | "chiefComplaint"
  | "presentIllness"
  | "pastHistory"
  | "personalHistory"
  | "familyHistory"
  | "allergyHistory"
  | "currentMedications";

type HistoryListKey = "problemFacts" | "recentChanges" | "redFlags";
type AuxiliaryKey = keyof EncounterRecordPayload["auxiliaryExams"];
type VitalKey =
  | "temperatureC"
  | "systolicBpMmhg"
  | "diastolicBpMmhg"
  | "pulseBpm"
  | "respiratoryRatePerMin";

const statusOptions: Array<{ value: MedicalFieldStatus; label: string }> = [
  { value: "PROVIDED", label: "已提供" },
  { value: "UNKNOWN", label: "未知" },
  { value: "NOT_APPLICABLE", label: "不适用" },
  { value: "PENDING_PHYSICIAN_CONFIRMATION", label: "待医生确认" },
];

const statusLabels: Record<MedicalFieldStatus, string> = {
  PROVIDED: "已提供",
  UNKNOWN: "未记录",
  NOT_APPLICABLE: "不适用",
  PENDING_PHYSICIAN_CONFIRMATION: "待医生确认",
};

const historyTextFields: Array<[HistoryTextKey, string]> = [
  ["chiefComplaint", "主诉"],
  ["presentIllness", "现病史"],
  ["pastHistory", "既往史"],
  ["personalHistory", "个人史"],
  ["familyHistory", "家族史"],
  ["allergyHistory", "过敏史"],
  ["currentMedications", "当前用药"],
];

const historyListFields: Array<[HistoryListKey, string]> = [
  ["problemFacts", "已提供的问题事实"],
  ["recentChanges", "近期变化"],
  ["redFlags", "危险信号"],
];

const auxiliaryFields: Array<[AuxiliaryKey, string]> = [
  ["laboratory", "实验室检查"],
  ["electrocardiogram", "心电检查"],
  ["imaging", "影像检查"],
  ["other", "其他辅助检查"],
];

const initialReferenceState: TransitionReferenceActionState = { status: "idle" };

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableSnapshot(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSnapshot).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableSnapshot(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function isContentStatus(status: MedicalFieldStatus): boolean {
  return status === "PROVIDED" || status === "PENDING_PHYSICIAN_CONFIRMATION";
}

function textStatus(field: MedicalTextField, status: MedicalFieldStatus): MedicalTextField {
  if (!isContentStatus(status)) return { status };
  return field.value !== undefined && field.value.trim().length > 0
    ? { status, value: field.value }
    : { status: "UNKNOWN" };
}

function listStatus(field: MedicalListField, status: MedicalFieldStatus): MedicalListField {
  if (!isContentStatus(status)) return { status };
  return field.items !== undefined && field.items.length > 0
    ? { status, items: field.items }
    : { status: "UNKNOWN" };
}

function textWithDoctorInput(field: MedicalTextField, value: string): MedicalTextField {
  if (value.trim().length === 0) return { status: "UNKNOWN" };
  return field.status === "PENDING_PHYSICIAN_CONFIRMATION"
    ? { status: field.status, value }
    : { status: "PROVIDED", value };
}

function listWithDoctorInput(field: MedicalListField, items: string[]): MedicalListField {
  if (items.length === 0) return { status: "UNKNOWN" };
  return field.status === "PENDING_PHYSICIAN_CONFIRMATION"
    ? { status: field.status, items }
    : { status: "PROVIDED", items };
}

function hasTextContent(field: MedicalTextField): boolean {
  return field.value !== undefined && field.value.trim().length > 0;
}

function hasListContent(field: MedicalListField): boolean {
  return field.items !== undefined && field.items.length > 0;
}

function AutoSizeTextarea({ value, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const maxHeight = 144;
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [value]);

  return <textarea {...props} ref={textareaRef} value={value} />;
}

function StatusMenu({
  label,
  status,
  disabled,
  canConfirm,
  onStatus,
  onConfirm,
  providedLabel = "已提供",
}: {
  label: string;
  status: MedicalFieldStatus;
  disabled: boolean;
  canConfirm: boolean;
  onStatus: (status: MedicalFieldStatus) => void;
  onConfirm: () => void;
  providedLabel?: string;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const closeMenu = useCallback((restoreFocus = false) => {
    const details = detailsRef.current;
    if (!details?.open) return;
    details.open = false;
    setIsOpen(false);
    if (restoreFocus) summaryRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const details = detailsRef.current;
    if (!details) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || details.contains(target)) return;
      closeMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !details.open) return;
      event.preventDefault();
      closeMenu(true);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeMenu, isOpen]);

  if (status === "PROVIDED") return null;

  const stateLabel = status === "PENDING_PHYSICIAN_CONFIRMATION"
    ? "待确认"
    : statusLabels[status];

  if (disabled) {
    return (
      <div className={styles.statusRail}>
        <span className={status === "PENDING_PHYSICIAN_CONFIRMATION" ? styles.pendingState : styles.mutedState}>
          {stateLabel}
        </span>
      </div>
    );
  }

  return (
    <div className={styles.statusRail}>
      <details
        ref={detailsRef}
        className={styles.statusMenu}
        name="medical-record-status-menu"
        onToggle={(event) => setIsOpen(event.currentTarget.open)}
      >
        <summary
          ref={summaryRef}
          aria-label={`${label}状态`}
          className={status === "PENDING_PHYSICIAN_CONFIRMATION" ? styles.pendingTrigger : styles.mutedTrigger}
        >
          {stateLabel}
        </summary>
        <div className={styles.statusMenuList}>
          {statusOptions.map((option) => {
            const optionLabel = option.value === "PROVIDED" ? providedLabel : option.label;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  closeMenu();
                  onStatus(option.value);
                }}
              >
                {optionLabel}
              </button>
            );
          })}
        </div>
      </details>
      {status === "PENDING_PHYSICIAN_CONFIRMATION" && (
        <button
          aria-label={`确认${label}`}
          className={styles.confirmButton}
          disabled={!canConfirm}
          title={canConfirm ? `确认${label}` : `请先补充${label}`}
          type="button"
          onClick={onConfirm}
        >
          确认
        </button>
      )}
    </div>
  );
}

function TextFieldEditor({
  id,
  label,
  field,
  multiline,
  readOnly,
  onStatus,
  onValue,
  onConfirm,
}: {
  id: string;
  label: string;
  field: MedicalTextField;
  multiline: boolean;
  readOnly: boolean;
  onStatus: (status: MedicalFieldStatus) => void;
  onValue: (value: string) => void;
  onConfirm: () => void;
}) {
  return (
    <div className={`${styles.fieldRow} ${multiline ? styles.largeRow : ""}`}>
      <div className={styles.fieldLabel}>
        <label htmlFor={`${id}-value`}>{label}</label>
      </div>
      <div className={styles.fieldControl}>
        {multiline ? (
          <AutoSizeTextarea
            aria-label={label}
            disabled={readOnly}
            id={`${id}-value`}
            maxLength={2_000}
            readOnly={readOnly}
            rows={1}
            value={field.value ?? ""}
            onChange={(event) => onValue(event.target.value)}
          />
        ) : (
          <input
            aria-label={label}
            disabled={readOnly}
            id={`${id}-value`}
            maxLength={2_000}
            readOnly={readOnly}
            type="text"
            value={field.value ?? ""}
            onChange={(event) => onValue(event.target.value)}
          />
        )}
      </div>
      <StatusMenu
        canConfirm={hasTextContent(field)}
        disabled={readOnly}
        label={label}
        onConfirm={onConfirm}
        onStatus={onStatus}
        status={field.status}
      />
    </div>
  );
}

function ListFieldEditor({
  id,
  label,
  field,
  readOnly,
  onStatus,
  onItems,
  onConfirm,
}: {
  id: string;
  label: string;
  field: MedicalListField;
  readOnly: boolean;
  onStatus: (status: MedicalFieldStatus) => void;
  onItems: (items: string[]) => void;
  onConfirm: () => void;
}) {
  return (
    <div className={styles.fieldRow}>
      <div className={styles.fieldLabel}>
        <label htmlFor={`${id}-items`}>{label}</label>
      </div>
      <div className={styles.fieldControl}>
        <AutoSizeTextarea
          aria-label={label}
          disabled={readOnly}
          id={`${id}-items`}
          maxLength={20_000}
          readOnly={readOnly}
          rows={1}
          value={field.items?.join("\n") ?? ""}
          onChange={(event) => onItems(event.target.value.split("\n").map((item) => item.trim()).filter(Boolean))}
        />
      </div>
      <StatusMenu
        canConfirm={hasListContent(field)}
        disabled={readOnly}
        label={label}
        onConfirm={onConfirm}
        onStatus={onStatus}
        status={field.status}
      />
    </div>
  );
}

function demographicText(
  field: { status: MedicalFieldStatus; value?: string | number },
  format: (value: string | number) => string = String,
): string {
  if ((field.status === "PROVIDED" || field.status === "PENDING_PHYSICIAN_CONFIRMATION") && field.value !== undefined) {
    return format(field.value);
  }
  return field.status === "NOT_APPLICABLE" ? "—" : "未知";
}

function sexText(value: string | number): string {
  if (value === "FEMALE") return "女";
  if (value === "MALE") return "男";
  if (value === "INTERSEX") return "其他受控值";
  return String(value);
}

function clientValidation(record: EncounterRecordPayload): string | undefined {
  const textFields = Object.values(record.history).filter((field): field is MedicalTextField => "value" in field);
  if (textFields.some((field) => isContentStatus(field.status) && (!field.value || field.value.trim().length === 0))) {
    return "请先补充病史中标记为待确认的内容。";
  }
  const listFields = [
    record.history.problemFacts,
    record.history.recentChanges,
    record.history.redFlags,
    record.physicalExam.notExaminedOrUnknown,
    record.missingInformation,
    record.patientEducationFacts,
  ];
  if (listFields.some((field) => isContentStatus(field.status) && (!field.items || field.items.length === 0))) {
    return "请先补充待核对的列表内容。";
  }
  const vital = record.physicalExam.vitalSigns;
  const vitalValue = vital.value;
  const hasVitalReading = vitalValue !== undefined && [
    vitalValue.temperatureC,
    vitalValue.systolicBpMmhg,
    vitalValue.diastolicBpMmhg,
    vitalValue.pulseBpm,
    vitalValue.respiratoryRatePerMin,
  ].some((value) => value !== undefined);
  if (isContentStatus(vital.status) && !hasVitalReading) return "生命体征至少需要一项实际数值。";
  if (Object.values(record.auxiliaryExams).some((field) => isContentStatus(field.status) && !field.result?.trim())) {
    return "请先补充待确认的检查结果。";
  }
  return undefined;
}

export function MedicalRecordEditor({
  view,
  speechCapability = { status: "UNCONFIGURED", reason: "PROVIDER_NOT_CONFIGURED" },
  speechTestFixture,
}: {
  view: MedicalRecordEditorView;
  speechCapability?: SpeechCapability;
  speechTestFixture?: SpeechPanelTestFixture;
}) {
  const [record, setRecord] = useState(() => clone(view.record));
  const [clientError, setClientError] = useState<string>();
  const [publicNotice, setPublicNotice] = useState<string>();
  const [speechPendingSuggestionCount, setSpeechPendingSuggestionCount] = useState(0);
  const [speechReferencePromptVisible, setSpeechReferencePromptVisible] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const initialSaveState: SaveMedicalRecordActionState = {
    status: "idle",
    revisionId: view.revisionId,
    revisionNumber: view.revisionNumber,
    updatedAt: view.expectedUpdatedAt,
  };
  const [saveState, saveAction, saving] = useActionState(saveMedicalRecordAction, initialSaveState);
  const [referenceState, referenceAction, transitioning] = useActionState(
    transitionToReferenceAction,
    initialReferenceState,
  );

  const editableSnapshot = useMemo(
    () => stableSnapshot(editableMedicalRecordPayloadOf(record)),
    [record],
  );
  const baselineSnapshot = saveState.status === "success" && saveState.record
    ? stableSnapshot(editableMedicalRecordPayloadOf(saveState.record))
    : stableSnapshot(editableMedicalRecordPayloadOf(view.record));
  const revisionId = saveState.revisionId;
  const revisionNumber = saveState.revisionNumber ?? 0;
  const expectedUpdatedAt = saveState.updatedAt ?? view.expectedUpdatedAt;
  const encounterStatus: EncounterStatus = view.encounter?.status === "DRAFT" && revisionNumber > 0
    ? "RECORD_SAVED"
    : view.encounter?.status ?? "DRAFT";
  const dirty = view.mode === "local-research" && editableSnapshot !== baselineSnapshot;
  const locked = view.readOnly || encounterStatus === "CONFIRMED";
  const referenceHref = view.mode === "public-demo"
    ? "/encounters/demo/reference"
    : `/encounters/${view.encounterId}/reference`;
  const speechWorkflow = useSpeechWorkflow({
    capability: speechCapability,
    encounterId: view.encounterId,
    fixture: speechTestFixture,
    onRecordChange: setRecord,
    readOnly: locked,
    record,
  });

  useEffect(() => {
    if (clientError || saveState.status === "error") errorRef.current?.focus();
  }, [clientError, saveState.status]);

  function updateRecord(mutator: (draft: EncounterRecordPayload) => void): void {
    setRecord((previous) => {
      const next = clone(previous);
      mutator(next);
      return next;
    });
    setClientError(undefined);
    setPublicNotice(undefined);
  }

  function updateHistoryText(key: HistoryTextKey, value?: string, status?: MedicalFieldStatus): void {
    updateRecord((draft) => {
      const field = draft.history[key];
      draft.history[key] = value === undefined ? textStatus(field, status ?? field.status) : textWithDoctorInput(field, value);
    });
  }

  function updateHistoryList(key: HistoryListKey, items?: string[], status?: MedicalFieldStatus): void {
    updateRecord((draft) => {
      const field = draft.history[key];
      draft.history[key] = items === undefined ? listStatus(field, status ?? field.status) : listWithDoctorInput(field, items);
    });
  }

  function updateVitalStatus(status: MedicalFieldStatus): void {
    updateRecord((draft) => {
      const existing = draft.physicalExam.vitalSigns.value;
      const hasReading = existing !== undefined && [
        existing.temperatureC,
        existing.systolicBpMmhg,
        existing.diastolicBpMmhg,
        existing.pulseBpm,
        existing.respiratoryRatePerMin,
      ].some((value) => value !== undefined);
      if (isContentStatus(status) && !hasReading) {
        draft.physicalExam.vitalSigns = { status: "UNKNOWN" };
        return;
      }
      draft.physicalExam.vitalSigns = status === "PROVIDED" || status === "PENDING_PHYSICIAN_CONFIRMATION"
        ? { status, ...(existing ? { value: existing } : {}) }
        : { status };
    });
  }

  function updateVitalValue(key: VitalKey, value: string): void {
    updateRecord((draft) => {
      const previous = draft.physicalExam.vitalSigns.value ?? {};
      const numeric = value.length > 0 ? Number(value) : undefined;
      const nextValue = { ...previous, [key]: numeric };
      Object.keys(nextValue).forEach((candidate) => {
        const candidateKey = candidate as keyof typeof nextValue;
        if (nextValue[candidateKey] === undefined || Number.isNaN(nextValue[candidateKey])) delete nextValue[candidateKey];
      });
      const hasReading = Object.keys(nextValue).some((candidate) => candidate !== "measuredAt");
      if (!hasReading) {
        draft.physicalExam.vitalSigns = { status: "UNKNOWN" };
        return;
      }
      draft.physicalExam.vitalSigns = {
        status: draft.physicalExam.vitalSigns.status === "PENDING_PHYSICIAN_CONFIRMATION" && hasReading
          ? "PENDING_PHYSICIAN_CONFIRMATION"
          : hasReading ? "PROVIDED" : draft.physicalExam.vitalSigns.status,
        ...(Object.keys(nextValue).length > 0 ? { value: nextValue } : {}),
      };
    });
  }

  function updateVitalDate(value: string): void {
    updateRecord((draft) => {
      const previous = draft.physicalExam.vitalSigns.value ?? {};
      const hasReading = Object.keys(previous).some((key) => key !== "measuredAt");
      if (!hasReading) return;
      const nextValue = { ...previous };
      if (value.length > 0) nextValue.measuredAt = value;
      else delete nextValue.measuredAt;
      draft.physicalExam.vitalSigns = { status: draft.physicalExam.vitalSigns.status, value: nextValue };
    });
  }

  function updateAuxiliaryStatus(key: AuxiliaryKey, status: MedicalFieldStatus): void {
    updateRecord((draft) => {
      const existing = draft.auxiliaryExams[key];
      draft.auxiliaryExams[key] = status === "PROVIDED" || status === "PENDING_PHYSICIAN_CONFIRMATION"
        ? { status, ...(existing.result === undefined ? {} : { result: existing.result }), ...(existing.examinationDate === undefined ? {} : { examinationDate: existing.examinationDate }) }
        : { status };
    });
  }

  function updateAuxiliaryResult(key: AuxiliaryKey, value: string): void {
    updateRecord((draft) => {
      const existing = draft.auxiliaryExams[key];
      if (value.trim().length === 0) {
        draft.auxiliaryExams[key] = { status: "UNKNOWN" };
        return;
      }
      const status = existing.status === "PENDING_PHYSICIAN_CONFIRMATION"
        ? "PENDING_PHYSICIAN_CONFIRMATION"
        : "PROVIDED";
      draft.auxiliaryExams[key] = {
        status,
        result: value,
      };
    });
  }

  function updateAuxiliaryDate(key: AuxiliaryKey, value: string): void {
    updateRecord((draft) => {
      const existing = draft.auxiliaryExams[key];
      if (!existing.result?.trim() && existing.status !== "PROVIDED") return;
      draft.auxiliaryExams[key] = {
        ...existing,
        ...(value.length > 0 ? { examinationDate: value } : {}),
      };
      if (value.length === 0) delete draft.auxiliaryExams[key].examinationDate;
    });
  }

  function updateGeneralText(key: "generalCondition" | "specialtyExam", value?: string, status?: MedicalFieldStatus): void {
    updateRecord((draft) => {
      const field = draft.physicalExam[key];
      draft.physicalExam[key] = value === undefined ? textStatus(field, status ?? field.status) : textWithDoctorInput(field, value);
    });
  }

  function updateNotExamined(items?: string[], status?: MedicalFieldStatus): void {
    updateRecord((draft) => {
      const field = draft.physicalExam.notExaminedOrUnknown;
      draft.physicalExam.notExaminedOrUnknown = items === undefined ? listStatus(field, status ?? field.status) : listWithDoctorInput(field, items);
    });
  }

  function updateMissing(items?: string[], status?: MedicalFieldStatus): void {
    updateRecord((draft) => {
      const field = draft.missingInformation;
      draft.missingInformation = items === undefined ? listStatus(field, status ?? field.status) : listWithDoctorInput(field, items);
    });
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    const message = clientValidation(record);
    if (message) {
      event.preventDefault();
      setClientError(message);
    }
  }

  function handleReferenceAttempt(event: MouseEvent<HTMLButtonElement>): void {
    if (speechPendingSuggestionCount === 0) return;
    event.preventDefault();
    setSpeechReferencePromptVisible(true);
  }

  function continueToReferenceAfterIgnoringSpeech(): void {
    setSpeechReferencePromptVisible(false);
    (document.getElementById("reference-form") as HTMLFormElement | null)?.requestSubmit();
  }

  function demographicItems(): Array<{ label: string; value: string }> {
    return [
      { label: "患者名称", value: view.patientDisplayName },
      { label: "性别", value: demographicText(record.demographics.sex, sexText) },
      { label: "年龄", value: demographicText(record.demographics.age, (value) => `${value}岁`) },
      { label: "职业", value: demographicText(record.demographics.occupation) },
      { label: "民族", value: demographicText(record.demographics.ethnicity) },
      { label: "婚姻状况", value: demographicText(record.demographics.maritalStatus) },
      { label: "籍贯/居住地", value: demographicText(record.demographics.syntheticRegion) },
      { label: "就诊日期", value: demographicText(record.demographics.visitDate) },
      { label: "入院日期", value: demographicText(record.demographics.admissionDate) },
      { label: "记录日期", value: demographicText(record.demographics.recordDate) },
    ];
  }

  const formFields = (
    <section className={styles.recordSheet} aria-label="病历工作表">
      <section className={styles.worksheetSection} aria-labelledby="history-title">
        <h2 id="history-title">病史</h2>
        <div className={styles.fieldRows}>
          {historyTextFields.map(([key, label]) => (
            <TextFieldEditor
              field={record.history[key]}
              id={`history-${key}`}
              key={key}
              label={label}
              multiline={key === "chiefComplaint" || key === "presentIllness"}
              onConfirm={() => updateHistoryText(key, undefined, "PROVIDED")}
              onStatus={(status) => updateHistoryText(key, undefined, status)}
              onValue={(value) => updateHistoryText(key, value)}
              readOnly={locked}
            />
          ))}
          {historyListFields.map(([key, label]) => (
            <ListFieldEditor
              field={record.history[key]}
              id={`history-${key}`}
              key={key}
              label={label}
              onConfirm={() => updateHistoryList(key, undefined, "PROVIDED")}
              onItems={(items) => updateHistoryList(key, items)}
              onStatus={(status) => updateHistoryList(key, undefined, status)}
              readOnly={locked}
            />
          ))}
        </div>
      </section>

      <section className={styles.worksheetSection} aria-labelledby="checks-title">
        <h2 id="checks-title">检查</h2>
        <div className={styles.vitalsRow}>
          <div className={styles.fieldLabel}><span>生命体征</span></div>
          <div className={styles.vitalInputs}>
            <label><span>体温</span><input aria-label="体温" disabled={locked} max="45" min="20" step="0.1" type="number" value={record.physicalExam.vitalSigns.value?.temperatureC ?? ""} onChange={(event) => updateVitalValue("temperatureC", event.target.value)} /></label>
            <label><span>脉搏</span><input aria-label="脉搏" disabled={locked} max="250" min="20" type="number" value={record.physicalExam.vitalSigns.value?.pulseBpm ?? ""} onChange={(event) => updateVitalValue("pulseBpm", event.target.value)} /></label>
            <label><span>呼吸</span><input aria-label="呼吸频率" disabled={locked} max="80" min="5" type="number" value={record.physicalExam.vitalSigns.value?.respiratoryRatePerMin ?? ""} onChange={(event) => updateVitalValue("respiratoryRatePerMin", event.target.value)} /></label>
            <label><span>收缩压</span><input aria-label="收缩压" disabled={locked} max="300" min="40" type="number" value={record.physicalExam.vitalSigns.value?.systolicBpMmhg ?? ""} onChange={(event) => updateVitalValue("systolicBpMmhg", event.target.value)} /></label>
            <label><span>舒张压</span><input aria-label="舒张压" disabled={locked} max="200" min="20" type="number" value={record.physicalExam.vitalSigns.value?.diastolicBpMmhg ?? ""} onChange={(event) => updateVitalValue("diastolicBpMmhg", event.target.value)} /></label>
            <label className={styles.vitalDate}><span>测量日期</span><input aria-label="生命体征测量日期" disabled={locked || !Object.keys(record.physicalExam.vitalSigns.value ?? {}).some((key) => key !== "measuredAt")} type="date" value={record.physicalExam.vitalSigns.value?.measuredAt ?? ""} onChange={(event) => updateVitalDate(event.target.value)} /></label>
          </div>
          <StatusMenu
            canConfirm={Object.keys(record.physicalExam.vitalSigns.value ?? {}).some((key) => key !== "measuredAt")}
            disabled={locked}
            label="生命体征"
            onConfirm={() => updateVitalStatus("PROVIDED")}
            onStatus={updateVitalStatus}
            status={record.physicalExam.vitalSigns.status}
          />
        </div>
        <TextFieldEditor
          field={record.physicalExam.generalCondition}
          id="general-condition"
          label="一般情况"
          multiline={false}
          onConfirm={() => updateGeneralText("generalCondition", undefined, "PROVIDED")}
          onStatus={(status) => updateGeneralText("generalCondition", undefined, status)}
          onValue={(value) => updateGeneralText("generalCondition", value)}
          readOnly={locked}
        />
        <TextFieldEditor
          field={record.physicalExam.specialtyExam}
          id="specialty-exam"
          label="专科体格检查"
          multiline
          onConfirm={() => updateGeneralText("specialtyExam", undefined, "PROVIDED")}
          onStatus={(status) => updateGeneralText("specialtyExam", undefined, status)}
          onValue={(value) => updateGeneralText("specialtyExam", value)}
          readOnly={locked}
        />
        <div className={styles.subsectionTitle}>辅助检查</div>
        <div className={styles.auxiliaryGrid}>
          {auxiliaryFields.map(([key, label]) => {
            const field = record.auxiliaryExams[key];
            const hasResult = field.result !== undefined && field.result.trim().length > 0;
            const showDate = hasResult || field.status === "PROVIDED";
            return (
              <div className={styles.fieldRow} key={key}>
                <div className={styles.fieldLabel}><label htmlFor={`auxiliary-${key}-result`}>{label}</label></div>
                <div className={styles.auxiliaryControl}>
                  <AutoSizeTextarea aria-label={`${label}结果`} disabled={locked} id={`auxiliary-${key}-result`} maxLength={500} readOnly={locked} rows={1} value={field.result ?? ""} onChange={(event) => updateAuxiliaryResult(key, event.target.value)} />
                  {showDate && <label className={styles.inlineDate} htmlFor={`auxiliary-${key}-date`}><span>日期</span><input aria-label={`${label}日期`} disabled={locked} id={`auxiliary-${key}-date`} type="date" value={field.examinationDate ?? ""} onChange={(event) => updateAuxiliaryDate(key, event.target.value)} /></label>}
                </div>
                <StatusMenu
                  canConfirm={hasResult}
                  disabled={locked}
                  label={label}
                  onConfirm={() => updateAuxiliaryStatus(key, "PROVIDED")}
                  onStatus={(status) => updateAuxiliaryStatus(key, status)}
                  providedLabel="已有结果"
                  status={field.status}
                />
              </div>
            );
          })}
        </div>
        <ListFieldEditor
          field={record.physicalExam.notExaminedOrUnknown}
          id="not-examined"
          label="未检查/未知项"
          onConfirm={() => updateNotExamined(undefined, "PROVIDED")}
          onItems={(items) => updateNotExamined(items)}
          onStatus={(status) => updateNotExamined(undefined, status)}
          readOnly={locked}
        />
      </section>

      <section className={styles.worksheetSection} aria-labelledby="pending-title">
        <h2 id="pending-title">待补充信息</h2>
        <ListFieldEditor
          field={record.missingInformation}
          id="missing-information"
          label="待补充事项"
          onConfirm={() => updateMissing(undefined, "PROVIDED")}
          onItems={(items) => updateMissing(items)}
          onStatus={(status) => updateMissing(undefined, status)}
          readOnly={locked}
        />
        {record.pendingInformation.length > 0 && (
          <div className={styles.pendingTags} aria-label="待医生确认清单">
            {record.pendingInformation.map((item) => (
              <span className={styles.pendingTag} key={item.id}>
                <span>{item.description}</span>
                <strong>待医生确认</strong>
              </span>
            ))}
          </div>
        )}
      </section>
    </section>
  );

  const actionBar = (
    <div className={styles.actionBar}>
      {view.mode !== "public-demo" && (
        <span className={styles.actionStatus} aria-live="polite">
          {saveState.status === "success" ? saveState.message : dirty ? "有未保存修改" : revisionNumber > 0 ? `已保存 · 修订 #${revisionNumber}` : "未保存"}
        </span>
      )}
      <button className={styles.primaryButton} disabled={view.mode === "local-research" && (saving || locked)} type={view.mode === "local-research" ? "submit" : "button"} onClick={view.mode === "public-demo" ? () => setPublicNotice("当前为只读演示，未保存任何内容") : undefined}>
        {saving ? "保存中" : "保存病历"}
      </button>
      {view.mode === "local-research" && saveState.status !== "error" && encounterStatus === "RECORD_SAVED" && !dirty && revisionId && !locked ? (
         <button className={styles.referenceButton} disabled={transitioning} form="reference-form" onClick={handleReferenceAttempt} type="submit">
          {transitioning ? "正在进入" : "进入AI参考"}
        </button>
      ) : view.mode === "public-demo" ? (
        <Link className={styles.referenceButton} href={referenceHref}>进入AI参考</Link>
      ) : view.mode === "local-research" && (encounterStatus === "REFERENCE_VIEWED" || encounterStatus === "REVIEW_PENDING") ? (
        <Link className={styles.referenceButton} href={referenceHref}>进入AI参考</Link>
      ) : null}
    </div>
  );

  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <span className={styles.eyebrow}>一次接诊</span>
          <h1>病历记录</h1>
        </div>
        <div className={styles.headerStatus}>
          <span className={styles.readOnlyBadge}>{view.mode === "public-demo" || locked ? "只读预览" : "本地研究"}</span>
          <strong>{view.mode === "public-demo" ? "未保存" : dirty ? "有未保存修改" : revisionNumber > 0 ? `已保存 · 修订 #${revisionNumber}` : "未保存"}</strong>
        </div>
      </header>

      <section className={styles.demographics} aria-label="患者基本信息">
        {demographicItems().map((item) => (
          <div className={styles.demographicItem} key={item.label}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </div>
        ))}
      </section>

      <div className={styles.workspace}>
        <div className={styles.editorColumn}>
          {view.mode === "local-research" ? (
            <form action={saveAction} onSubmit={handleSubmit}>
              <input name="encounterId" type="hidden" value={view.encounterId} />
              <input name="expectedUpdatedAt" type="hidden" value={expectedUpdatedAt} />
              <input name="expectedCurrentRecordRevisionId" type="hidden" value={revisionId ?? ""} />
              <input name="expectedRevisionNumber" type="hidden" value={revisionNumber} />
              <input name="editableRecord" type="hidden" value={JSON.stringify(editableMedicalRecordPayloadOf(record))} />
              {formFields}
              {actionBar}
              {(clientError || saveState.status === "error") && (
                <div ref={errorRef} className={styles.errorSummary} role="alert" tabIndex={-1}>
                  <strong>病历未保存</strong>
                  <span>{clientError ?? saveState.message}</span>
                </div>
              )}
            </form>
          ) : (
            <div>
              {formFields}
              {actionBar}
              {publicNotice && <div className={styles.notice} role="status">{publicNotice}</div>}
            </div>
          )}
          {view.mode === "local-research" && encounterStatus === "RECORD_SAVED" && (
            <form id="reference-form" action={referenceAction} className={styles.referenceForm}>
              <input name="encounterId" type="hidden" value={view.encounterId} />
              <input name="expectedStatus" type="hidden" value={encounterStatus} />
              <input name="expectedUpdatedAt" type="hidden" value={expectedUpdatedAt} />
              <input name="currentRecordRevisionId" type="hidden" value={revisionId ?? ""} />
              {referenceState.status === "error" && <span className={styles.errorInline} role="alert">{referenceState.message}</span>}
            </form>
          )}
        </div>
        <SpeechPanel
          capability={speechCapability}
          onDismissReferencePrompt={() => setSpeechReferencePromptVisible(false)}
          onIgnorePendingAndContinue={continueToReferenceAfterIgnoringSpeech}
          onPendingCountChange={setSpeechPendingSuggestionCount}
          readOnly={locked}
          referencePromptVisible={speechReferencePromptVisible}
          workflow={speechWorkflow}
        />
      </div>
    </main>
  );
}
