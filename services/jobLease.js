/**
 * MongoDB-backed lease for background jobs, with owner-checked acquire / renew / release and fenced state writes.
 *
 * Every decision is made inside ONE atomic update on the job's checkpoint document using the database's own
 * clock ($$NOW), so process clocks and clock skew between processes never matter:
 *   - acquire:  succeeds only when the lease is free, expired, or already held by the same owner;
 *   - renew:    succeeds only for the current owner while the lease has not expired;
 *   - release:  clears the lease only if the caller still owns it;
 *   - state writes: apply only while the caller owns an unexpired lease, so a paused process that lost its
 *               lease can never overwrite the progress of the process that replaced it.
 * Needs MongoDB 4.2+ (update pipelines and $$NOW).
 */
const FREE = ["null", "missing"];

function collectionOf(model) {
  const collection = model?.collection;
  if (!collection) throw new TypeError("A MongoDB model is required");
  return collection;
}

/** @returns {Promise<{name:string, owner:string, ttlMs:number}|null>} null when another owner holds a live lease */
export async function acquireLease(model, name, owner, ttlMs) {
  if (!name || !owner || !Number.isInteger(ttlMs) || ttlMs < 1) throw new TypeError("name, owner and a positive integer ttlMs are required");
  const collection = collectionOf(model);
  try {
    await collection.updateOne(
      { name },
      { $setOnInsert: { name, leaseOwner: null, leaseUntil: null, state: {}, updatedAt: new Date() } },
      { upsert: true },
    );
  } catch (error) {
    if (error?.code !== 11000) throw error; // a concurrent first insert won: the document exists now
  }
  const acquired = await collection.findOneAndUpdate(
    {
      name,
      $expr: {
        $or: [
          { $eq: ["$leaseOwner", owner] },
          { $in: [{ $type: "$leaseUntil" }, FREE] },
          { $lte: ["$leaseUntil", "$$NOW"] },
        ],
      },
    },
    [{ $set: { leaseOwner: owner, leaseUntil: { $add: ["$$NOW", ttlMs] } } }],
    { returnDocument: "after" },
  );
  return acquired ? { name, owner, ttlMs } : null;
}

/** Extends a lease that is still owned and unexpired. */
export async function renewLease(model, lease) {
  const result = await collectionOf(model).updateOne(
    { name: lease.name, leaseOwner: lease.owner, $expr: { $gt: ["$leaseUntil", "$$NOW"] } },
    [{ $set: { leaseUntil: { $add: ["$$NOW", lease.ttlMs] } } }],
  );
  return result.matchedCount === 1;
}

/** Releases only a lease this owner still holds. */
export async function releaseLease(model, lease) {
  const result = await collectionOf(model).updateOne(
    { name: lease.name, leaseOwner: lease.owner },
    { $set: { leaseOwner: null, leaseUntil: null } },
  );
  return result.matchedCount === 1;
}

/**
 * Fenced write of job progress: `set` keys are dotted below `state`, `unset` lists keys to remove.
 * Returns false (and writes nothing) when the caller no longer owns an unexpired lease.
 */
export async function writeLeasedState(model, lease, { set = {}, unset = [] } = {}) {
  const update = { $set: { updatedAt: new Date() } };
  for (const [key, value] of Object.entries(set)) update.$set[`state.${key}`] = value;
  if (unset.length) update.$unset = Object.fromEntries(unset.map((key) => [`state.${key}`, ""]));
  const result = await collectionOf(model).updateOne(
    { name: lease.name, leaseOwner: lease.owner, $expr: { $gt: ["$leaseUntil", "$$NOW"] } },
    update,
  );
  return result.matchedCount === 1;
}

export async function readCheckpoint(model, name) {
  return collectionOf(model).findOne({ name });
}

/** The database's current time (falls back to the process clock when the server does not report it). */
export async function databaseNow(model) {
  try {
    const hello = await model.db.db.command({ hello: 1 });
    if (hello?.localTime) return new Date(hello.localTime);
  } catch { /* fall through */ }
  return new Date();
}
