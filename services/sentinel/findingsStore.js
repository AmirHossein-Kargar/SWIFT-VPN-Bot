/**
 * The only module in services/sentinel that writes to the database, and SentinelFinding is the only collection it knows.
 * Keeping the writes here is what makes the read-only guarantee checkable by a scan of the folder.
 */
import { createHash } from "node:crypto";
import SentinelFinding from "../../models/SentinelFinding.js";

const REWRITE_AFTER_MS = 60 * 60_000; // an unchanged finding is rewritten at most hourly
const CLEARED_RETENTION_MS = 180 * 24 * 60 * 60_000;
const QUERY_TIMEOUT_MS = 8_000;
const REVIEW_HISTORY_LIMIT = 30;

export function evidenceHash(finding) {
  const { classification, severity, amountToman, direction, expected, observed, expectedToman, observedToman, facts } = finding;
  return createHash("sha256")
    .update(JSON.stringify({ classification, severity, amountToman, direction, expected, observed, expectedToman, observedToman, facts }))
    .digest("hex");
}

/** A rule's output, ready for the collection. Fields the detector does not own (review, history) are never here. */
function detectorFields(finding, now) {
  return {
    code: finding.code,
    category: finding.category,
    classification: finding.classification,
    severity: finding.severity,
    rank: finding.rank,
    userId: finding.userId,
    subjectType: finding.subjectType,
    subjectKey: finding.subjectKey,
    impactKey: finding.impactKey,
    amountToman: finding.amountToman,
    direction: finding.direction,
    expected: finding.expected,
    observed: finding.observed,
    expectedToman: finding.expectedToman,
    observedToman: finding.observedToman,
    facts: finding.facts,
    refs: finding.refs,
    ruleVersion: finding.ruleVersion,
    evidenceHash: evidenceHash(finding),
    state: "open",
    lastDetectedAt: now,
    lastCheckedAt: now,
    clearedAt: null,
    expireAt: null,
  };
}

export async function openFingerprints(userIds, { model = SentinelFinding } = {}) {
  const rows = await model.find({ userId: { $in: userIds }, state: "open" }).select("fingerprint userId").lean().maxTimeMS(QUERY_TIMEOUT_MS);
  return new Set(rows.map((row) => row.fingerprint));
}

/**
 * Make the stored findings of one batch of customers match what evaluation just found. Idempotent: the fingerprint is
 * unique, so a repeat run or a concurrent one lands on the same rows, and an unchanged finding is not rewritten at all.
 *   - new problem         -> one row, review "new"
 *   - same evidence       -> untouched (lastCheckedAt moves in one bulk write)
 *   - changed evidence    -> updated in place; a dismissal covered the old evidence only, so it lapses
 *   - gone                -> state "cleared", retained, review kept
 *   - cleared, came back  -> reopened; a past "resolved" no longer stands
 */
export async function syncFindings({ userIds, findings, now = new Date(), model = SentinelFinding }) {
  const summary = { created: 0, updated: 0, unchanged: 0, reopened: 0, cleared: 0 };
  const existing = await model.find({ userId: { $in: userIds } })
    .select("fingerprint state review evidenceHash lastDetectedAt").lean().maxTimeMS(QUERY_TIMEOUT_MS);
  const byFingerprint = new Map(existing.map((row) => [row.fingerprint, row]));
  const operations = [];

  for (const finding of findings) {
    const stored = byFingerprint.get(finding.fingerprint);
    const fields = detectorFields(finding, now);
    if (!stored) {
      operations.push({
        updateOne: {
          filter: { fingerprint: finding.fingerprint },
          update: { $setOnInsert: { fingerprint: finding.fingerprint, review: "new", reviewHistory: [], firstDetectedAt: now, reopenCount: 0 }, $set: fields, $inc: { detections: 1 } },
          upsert: true,
        },
      });
      summary.created += 1;
    } else if (stored.state === "cleared") {
      const reopen = { ...fields, ...(stored.review === "false_positive" ? {} : { review: "new" }) };
      operations.push({ updateOne: { filter: { fingerprint: finding.fingerprint, state: "cleared" }, update: { $set: reopen, $inc: { detections: 1, reopenCount: 1 } } } });
      summary.reopened += 1;
    } else if (stored.evidenceHash !== fields.evidenceHash || now - new Date(stored.lastDetectedAt) >= REWRITE_AFTER_MS) {
      const changed = stored.evidenceHash !== fields.evidenceHash;
      const lapsed = changed && ["false_positive", "resolved"].includes(stored.review) ? { review: "new" } : {};
      operations.push({ updateOne: { filter: { fingerprint: finding.fingerprint }, update: { $set: { ...fields, ...lapsed }, $inc: { detections: 1 } } } });
      summary.updated += 1;
    } else {
      summary.unchanged += 1;
    }
  }

  const present = new Set(findings.map((finding) => finding.fingerprint));
  const gone = existing.filter((row) => row.state === "open" && !present.has(row.fingerprint)).map((row) => row.fingerprint);
  if (gone.length) {
    operations.push({
      updateMany: {
        filter: { fingerprint: { $in: gone }, state: "open" },
        update: { $set: { state: "cleared", clearedAt: now, lastCheckedAt: now, expireAt: new Date(now.getTime() + CLEARED_RETENTION_MS) } },
      },
    });
    summary.cleared = gone.length;
  }
  if (operations.length) {
    try {
      await model.bulkWrite(operations, { ordered: false });
    } catch (error) {
      // Two evaluators inserted the same new fingerprint: the unique index kept one row, which is the point.
      const writeErrors = error?.writeErrors || [];
      if (error?.code !== 11000 && !(writeErrors.length && writeErrors.every((item) => (item.code ?? item.err?.code) === 11000))) throw error;
    }
  }
  await model.updateMany({ userId: { $in: userIds }, state: "open" }, { $set: { lastCheckedAt: now } });
  return summary;
}

export const REVIEW_TRANSITIONS = Object.freeze({
  new: ["investigating", "remediation_proposed", "resolved", "false_positive"],
  investigating: ["remediation_proposed", "resolved", "false_positive"],
  remediation_proposed: ["investigating", "resolved", "false_positive"],
  resolved: ["investigating"],
  false_positive: ["investigating"],
});

/** Compare-and-set on the current review, so two admins cannot overwrite each other unseen. Never touches detector fields. */
export async function recordReview({ id, from, to, actor, reason, optionId = null, operationId = null, now = new Date(), model = SentinelFinding }) {
  return model.findOneAndUpdate(
    { _id: id, review: from },
    {
      $set: { review: to },
      $push: { reviewHistory: { $each: [{ at: now, actor, from, to, reason, optionId, operationId }], $slice: -REVIEW_HISTORY_LIMIT } },
    },
    { new: true },
  ).lean();
}
