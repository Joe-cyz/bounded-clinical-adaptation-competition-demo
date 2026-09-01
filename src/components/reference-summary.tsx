"use client";

import { useState } from "react";

import type { MedicalRecordSummary } from "@/domain/reference";

import styles from "./reference-workspace.module.css";

export function ReferenceSummary({ summary }: { summary: MedicalRecordSummary }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={styles.summaryBody}>
      <p className={expanded ? styles.summaryTextExpanded : styles.summaryText} data-testid="reference-summary-text">
        {expanded ? summary.fullText : summary.previewText}
      </p>
      {summary.isExpandable && (
        <button
          aria-expanded={expanded}
          className={styles.textToggle}
          onClick={() => setExpanded((current) => !current)}
          type="button"
        >
          {expanded ? "收起" : "展开"}
        </button>
      )}
    </div>
  );
}
