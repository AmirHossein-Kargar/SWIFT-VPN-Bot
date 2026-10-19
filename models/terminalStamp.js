/**
 * Mongoose plugin that records WHEN an invoice first reached a definitive
 * cancelled/failed state, on every write path (save, updateOne, updateMany,
 * findOneAndUpdate).
 *
 * `terminalStatusAt` has no default on purpose: for updates the stamp uses
 * `$min`, which only ever lowers the value and sets it when the field is
 * missing, so a repeated notification for the same status can never reset the
 * clock. (A null default would win every `$min` comparison and block the stamp.)
 */
export function applyTerminalStatusStamp(schema, statuses, { now = () => new Date() } = {}) {
  const terminal = new Set(statuses);
  schema.add({ terminalStatusAt: { type: Date } });
  schema.index({ status: 1, terminalStatusAt: 1 }, { name: "idx_terminal_status_cleanup", sparse: true });

  schema.pre("save", function stampOnSave(next) {
    if (terminal.has(this.status) && !(this.terminalStatusAt instanceof Date)) {
      this.terminalStatusAt = now();
    }
    next();
  });

  function stampOnUpdate(next) {
    const update = this.getUpdate?.();
    if (!update || Array.isArray(update)) return next();
    const status = update.$set?.status ?? update.status;
    if (typeof status === "string" && terminal.has(status)) {
      this.setUpdate({ ...update, $min: { ...(update.$min || {}), terminalStatusAt: now() } });
    }
    return next();
  }
  schema.pre("updateOne", stampOnUpdate);
  schema.pre("updateMany", stampOnUpdate);
  schema.pre("findOneAndUpdate", stampOnUpdate);
}

export default { applyTerminalStatusStamp };
