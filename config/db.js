import mongoose from "mongoose";
import { resolveMongoUrl } from "./env.js";

const DEFAULT_TIMEOUT_MS = 10_000;

/** Connect and ping MongoDB. Configuration/driver errors never include a URI. */
export async function connectDB({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const resolved = resolveMongoUrl();
  if (!resolved) {
    throw new Error("MongoDB is not configured; set MONGO_URL or the Railway MongoDB connection variables.");
  }

  try {
    await mongoose.connect(resolved.url, {
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
      maxPoolSize: 20,
      minPoolSize: 0,
      autoIndex: process.env.NODE_ENV !== "production",
    });
    await mongoose.connection.db.command({ ping: 1 });
    // Create missing indexes without dropping existing ones. Unique user IDs,
    // payment IDs, and on-chain transaction hashes are part of the money-safety
    // model, so production must not silently run without them.
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).createIndexes()));
    console.log(`MongoDB connected and indexes checked (configuration: ${resolved.source})`);
    return mongoose.connection;
  } catch (error) {
    await mongoose.disconnect().catch(() => {});
    const code = typeof error?.code === "string" || typeof error?.code === "number" ? `, code ${error.code}` : "";
    throw new Error(`MongoDB connection failed (${resolved.source}${code}). Check Railway service networking and credentials.`);
  }
}

export default connectDB;
