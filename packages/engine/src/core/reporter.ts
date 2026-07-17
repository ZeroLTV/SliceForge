import * as fs from "fs";
import * as path from "path";
import type {
  DoctorReport,
  EvaluationRecord,
  GateResult,
  RunEvent,
  RunRecord,
  TaskEvent,
  TaskRecord,
} from "./contracts.js";
import type { RuntimeStore } from "./runtime-store.js";
import { redactText } from "./redaction.js";

interface ReportAlias {
  value: string | undefined;
  replacement: string;
}

function replaceLiteral(value: string, search: string, replacement: string): string {
  if (!search) return value;
  const pattern = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value.replace(new RegExp(pattern, process.platform === "win32" ? "gi" : "g"), replacement);
}

function escapedHtmlLiteral(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function sanitizeReport(value: string, aliases: ReportAlias[]): string {
  const expanded = aliases
    .flatMap(({ value: target, replacement }) => {
      if (!target || target.length < 4) return [];
      const normalized = target.replace(/\\/g, "/");
      const variants = [
        target,
        normalized,
        target.replace(/\\/g, "\\\\"),
        escapedHtmlLiteral(target),
        escapedHtmlLiteral(target.replace(/\\/g, "\\\\")),
        escapedHtmlLiteral(normalized),
      ];
      return [...new Set(variants)].map((item) => ({ value: item, replacement }));
    })
    .sort((left, right) => right.value.length - left.value.length);
  let output = value;
  for (const alias of expanded) {
    output = replaceLiteral(output, alias.value, alias.replacement);
  }
  return redactText(output);
}

function responseSummary(response: {
  status: string;
  summary: string;
  artifacts: string[];
  diagnostics: unknown;
  usage?: unknown;
}): Record<string, unknown> {
  return {
    status: response.status,
    summary: response.summary,
    artifacts: response.artifacts,
    diagnostics: response.diagnostics,
    usage: response.usage,
  };
}

function responseSummaries(
  responses: Record<
    string,
    | {
        status: string;
        summary: string;
        artifacts: string[];
        diagnostics: unknown;
        usage?: unknown;
      }
    | undefined
  >,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(responses).map(([role, response]) => [
      role,
      response ? responseSummary(response) : undefined,
    ]),
  );
}

function agentSummary(run: RunRecord): Record<string, unknown> {
  return responseSummaries(run.agentResponses);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function gateRows(gates: GateResult[]): string {
  return gates
    .map(
      (gate) => `<tr>
        <td><span class="status ${escapeHtml(gate.status)}">${escapeHtml(gate.status)}</span></td>
        <td>${escapeHtml(gate.kind)}</td><td>${escapeHtml(gate.id)}</td>
        <td>${escapeHtml(gate.summary)}</td><td>${gate.durationMs} ms</td>
      </tr>`,
    )
    .join("\n");
}

function eventRows(events: RunEvent[]): string {
  return events
    .map(
      (event) =>
        `<li><time>${escapeHtml(event.timestamp)}</time><strong>${escapeHtml(event.status)}</strong>${escapeHtml(event.message)}</li>`,
    )
    .join("\n");
}

function gateDetails(gates: GateResult[]): string {
  return gates
    .map(
      (gate) =>
        `<h3>${escapeHtml(gate.id)}</h3><pre>command: ${escapeHtml(
          gate.command ? JSON.stringify(gate.command) : "none",
        )}\nartifacts: ${escapeHtml(gate.artifacts.join(", ") || "none")}\n\nstdout:\n${escapeHtml(
          gate.stdout || "(empty)",
        )}\n\nstderr:\n${escapeHtml(gate.stderr || "(empty)")}</pre>`,
    )
    .join("\n");
}

function document(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title><style>
  :root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#f6f7f9;color:#18202a}body{margin:0}main{max-width:1180px;margin:auto;padding:32px 24px 64px}h1{font-size:28px;margin:0 0 8px}h2{font-size:18px;margin-top:32px;border-bottom:1px solid #d8dde5;padding-bottom:8px}.meta{color:#596574;margin:0 0 24px}.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.metric{background:white;border:1px solid #d8dde5;border-radius:6px;padding:14px}.metric b{display:block;font-size:19px;margin-top:4px}table{width:100%;border-collapse:collapse;background:white;border:1px solid #d8dde5}th,td{text-align:left;padding:10px;border-bottom:1px solid #e5e8ed;vertical-align:top}th{font-size:12px;text-transform:uppercase;color:#596574}.status{font-size:12px;font-weight:700}.passed,.promoted,.ready_to_promote{color:#08783e}.failed,.blocked{color:#b42318}.warning,.needs_attention{color:#9a6700}ol{padding-left:20px}li{margin:8px 0}time{color:#687386;margin-right:12px;font-family:ui-monospace,monospace;font-size:12px}li strong{margin-right:10px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#111820;color:#e9eef5;padding:14px;border-radius:6px;max-height:420px;overflow:auto}.next{border-left:4px solid #2463eb;padding:12px 16px;background:#eef4ff}@media(prefers-color-scheme:dark){:root{background:#101419;color:#e7edf4}.metric,table{background:#171d24;border-color:#303946}th,td,h2{border-color:#303946}.meta,th,time{color:#9ba8b6}.next{background:#17233b}}
  </style></head><body><main>${body}</main></body></html>`;
}

export class HtmlReporter {
  constructor(private readonly store: RuntimeStore) {}

  writeRun(run: RunRecord): string {
    const events = this.store.readEvents(run.runId);
    const totalCost = Object.values(run.agentResponses).reduce(
      (total, response) => total + (response?.usage?.estimatedCostUSD ?? 0),
      0,
    );
    const nextAction =
      run.status === "ready_to_promote"
        ? `sliceforge promote ${run.runId}`
        : run.status === "needs_attention"
          ? `sliceforge promote ${run.runId} --accept-attention`
          : run.status === "blocked"
            ? `sliceforge rebase ${run.runId}`
            : `sliceforge inspect ${run.runId}`;
    const body = `<h1>SliceForge run ${escapeHtml(run.runId)}</h1>
      <p class="meta">Local report. No source or telemetry was uploaded by SliceForge.</p>
      <section class="summary"><div class="metric">Status<b class="status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</b></div>
      <div class="metric">Slice<b>${escapeHtml(run.sliceId)}</b></div><div class="metric">Attempt<b>${run.attempt}</b></div>
      <div class="metric">Gates<b>${run.gates.filter((gate) => gate.status === "passed").length}/${run.gates.length}</b></div>
      <div class="metric">Estimated agent cost<b>$${totalCost.toFixed(4)}</b></div></section>
      <p class="next"><b>Next action</b><br><code>${escapeHtml(nextAction)}</code></p>
      <h2>Validation gates</h2><table><thead><tr><th>Status</th><th>Kind</th><th>ID</th><th>Summary</th><th>Duration</th></tr></thead><tbody>${gateRows(run.gates)}</tbody></table>
      <h2>Gate evidence and logs</h2>${gateDetails(run.gates)}
      <h2>Timeline</h2><ol>${eventRows(events)}</ol>
      <h2>Acceptance coverage</h2><table><thead><tr><th>Status</th><th>Acceptance</th><th>Evidence</th></tr></thead><tbody>${(run.acceptanceCoverage ?? []).map((item) => `<tr><td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.id)}</td><td>${escapeHtml(item.evidence.join(", ") || "No independent evidence mapping")}</td></tr>`).join("\n")}</tbody></table>
      <h2>Changed files</h2><pre>${escapeHtml((run.changedFiles ?? []).join("\n") || "No recorded changes")}</pre>
      <h2>Sanitized diff</h2><pre>${escapeHtml(run.sanitizedDiff ?? "Diff unavailable")}</pre>
      <h2>Policy violations</h2><pre>${escapeHtml((run.policyViolations ?? []).join("\n") || "None")}</pre>
      <h2>Agent summaries</h2><pre>${escapeHtml(JSON.stringify(agentSummary(run), null, 2))}</pre>
      <h2>Runtime resources</h2><pre>${escapeHtml(JSON.stringify({ environment: run.runtimeEnv ?? {}, leaseScope: "agent-and-validation-execution" }, null, 2))}</pre>
      <h2>Git</h2><pre>base: ${escapeHtml(run.baseSha)}\nbranch: ${escapeHtml(run.branchName)}\ncommit: ${escapeHtml(run.commitSha ?? "not committed")}</pre>`;
    const reportPath = path.join(this.store.paths.reports, `${run.runId}.html`);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(
      reportPath,
      sanitizeReport(document(`SliceForge ${run.runId}`, body), [
        { value: run.worktreePath, replacement: "$WORKTREE" },
        { value: run.projectRoot, replacement: "$PROJECT_ROOT" },
        { value: this.store.paths.root, replacement: "$RUNTIME_ROOT" },
      ]),
      "utf8",
    );
    return reportPath;
  }

  writeTask(task: TaskRecord, events: TaskEvent[]): string {
    const nextAction =
      task.status === "clarifying"
        ? `sliceforge task answer ${task.taskId}`
        : task.status === "awaiting_approval"
          ? `sliceforge task approve ${task.taskId}`
          : task.status === "queued"
            ? "sliceforge queue start"
            : task.status === "ready_to_promote" && task.runIds.at(-1)
              ? `sliceforge promote ${task.runIds.at(-1)}`
              : `sliceforge task inspect ${task.taskId}`;
    const body = `<h1>SliceForge task ${escapeHtml(task.taskId)}</h1>
      <p class="meta">Local task report. Attachments and context remain in the local runtime store.</p>
      <section class="summary"><div class="metric">Status<b class="status ${escapeHtml(task.status)}">${escapeHtml(task.status)}</b></div>
      <div class="metric">Readiness<b>${task.packet.readinessScore}/100</b></div>
      <div class="metric">Revision<b>${task.revision}</b></div>
      <div class="metric">Evidence<b>${task.evidence.filter((item) => item.status === "verified").length}/${task.evidence.length}</b></div></section>
      <p class="next"><b>Next action</b><br><code>${escapeHtml(nextAction)}</code></p>
      <h2>Request and decisions</h2><pre>${escapeHtml(task.request.request)}\n\n${escapeHtml(JSON.stringify(task.packet.decisions, null, 2))}</pre>
      <h2>Clarifier and planner protocol</h2><pre>${escapeHtml(JSON.stringify(task.planningAgentResponses ? responseSummaries(task.planningAgentResponses) : "Deterministic planning fallback", null, 2))}</pre>
      <h2>Slice graph</h2><pre>${escapeHtml(JSON.stringify(task.graph ?? "Plan not generated", null, 2))}</pre>
      <h2>Acceptance evidence</h2><pre>${escapeHtml(JSON.stringify(task.evidence, null, 2))}</pre>
      <h2>Timeline</h2><ol>${events
        .map(
          (event) =>
            `<li><time>${escapeHtml(event.timestamp)}</time><strong>${escapeHtml(event.status)}</strong>${escapeHtml(event.message)}</li>`,
        )
        .join("\n")}</ol>`;
    const reportPath = path.join(this.store.paths.reports, `task-${task.taskId}.html`);
    const attachmentAliases = task.request.attachments.flatMap((attachment) => [
      { value: attachment.storedPath, replacement: "$ATTACHMENT_PATH" },
      {
        value: path.isAbsolute(attachment.source) ? attachment.source : undefined,
        replacement: "$INPUT_PATH",
      },
    ]);
    fs.writeFileSync(
      reportPath,
      sanitizeReport(document(`SliceForge task ${task.taskId}`, body), [
        ...attachmentAliases,
        { value: task.projectRoot, replacement: "$PROJECT_ROOT" },
        { value: this.store.paths.root, replacement: "$RUNTIME_ROOT" },
      ]),
      "utf8",
    );
    return reportPath;
  }

  writeEvaluation(record: EvaluationRecord): string {
    const body = `<h1>SliceForge evaluation ${escapeHtml(record.evaluationId)}</h1>
      <p class="meta">Suite ${escapeHtml(record.suite)} · ${escapeHtml(record.createdAt)}</p>
      <section class="summary"><div class="metric">Regression<b class="status ${record.regression.passed ? "passed" : "failed"}">${record.regression.passed ? "passed" : "failed"}</b></div>
      <div class="metric">Task success<b>${(record.metrics.taskSuccessRate * 100).toFixed(1)}%</b></div>
      <div class="metric">Acceptance<b>${(record.metrics.acceptanceVerificationRate * 100).toFixed(1)}%</b></div>
      <div class="metric">Schema compliance<b>${(record.metrics.schemaComplianceRate * 100).toFixed(1)}%</b></div></section>
      <h2>Regression reasons</h2><pre>${escapeHtml(record.regression.reasons.join("\n") || "None")}</pre>
      <h2>Baseline provenance drift</h2><pre>${escapeHtml(JSON.stringify(record.regression.drift ?? "No baseline comparison", null, 2))}</pre>
      <h2>Metrics</h2><pre>${escapeHtml(JSON.stringify(record.metrics, null, 2))}</pre>
      <h2>Agent and context fingerprints</h2><pre>${escapeHtml(JSON.stringify({ agentVersions: record.agentVersions, configFingerprint: record.configFingerprint, contextFingerprint: record.contextFingerprint }, null, 2))}</pre>
      <h2>Trials</h2><pre>${escapeHtml(JSON.stringify(record.trials, null, 2))}</pre>`;
    const reportPath = path.join(
      this.store.paths.reports,
      `evaluation-${record.evaluationId}.html`,
    );
    fs.writeFileSync(
      reportPath,
      sanitizeReport(document(`SliceForge evaluation ${record.evaluationId}`, body), [
        { value: this.store.paths.root, replacement: "$RUNTIME_ROOT" },
      ]),
      "utf8",
    );
    return reportPath;
  }

  writeDoctor(report: DoctorReport): string {
    const rows = report.checks
      .map(
        (check) =>
          `<tr><td><span class="status ${check.status === "pass" ? "passed" : check.status === "fail" ? "failed" : "warning"}">${escapeHtml(check.status)}</span></td><td>${escapeHtml(check.id)}</td><td>${escapeHtml(check.message)}${check.remediation ? `<br><small>${escapeHtml(check.remediation)}</small>` : ""}</td></tr>`,
      )
      .join("\n");
    const reportPath = path.join(this.store.paths.reports, `doctor-${Date.now()}.html`);
    fs.writeFileSync(
      reportPath,
      sanitizeReport(
        document(
          "SliceForge doctor",
          `<h1>SliceForge doctor</h1><p class="meta">${escapeHtml(report.projectRoot)}</p><table><thead><tr><th>Status</th><th>Check</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table>`,
        ),
        [
          { value: report.projectRoot, replacement: "$PROJECT_ROOT" },
          { value: this.store.paths.root, replacement: "$RUNTIME_ROOT" },
        ],
      ),
      "utf8",
    );
    return reportPath;
  }

  writeVerification(projectRoot: string, gates: GateResult[], passed: boolean): string {
    const reportPath = path.join(this.store.paths.reports, `verify-${Date.now()}.html`);
    const body = `<h1>SliceForge verification</h1><p class="meta">${escapeHtml(projectRoot)}</p>
      <section class="summary"><div class="metric">Result<b class="status ${passed ? "passed" : "failed"}">${passed ? "passed" : "failed"}</b></div>
      <div class="metric">Gates<b>${gates.filter((gate) => gate.status === "passed").length}/${gates.length}</b></div></section>
      <h2>Deterministic gates</h2><table><thead><tr><th>Status</th><th>Kind</th><th>ID</th><th>Summary</th><th>Duration</th></tr></thead><tbody>${gateRows(gates)}</tbody></table>
      <h2>Gate evidence and logs</h2>${gateDetails(gates)}`;
    fs.writeFileSync(
      reportPath,
      sanitizeReport(document("SliceForge verification", body), [
        { value: projectRoot, replacement: "$PROJECT_ROOT" },
        { value: this.store.paths.root, replacement: "$RUNTIME_ROOT" },
      ]),
      "utf8",
    );
    return reportPath;
  }
}
