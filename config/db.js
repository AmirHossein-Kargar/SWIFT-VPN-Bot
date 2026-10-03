/**
 * MongoDB connection.
 *
 * The URI is resolved through config/env.js so that platform-provided names
 * (MONGO_URL, MONGODB_URI, MONGOHOST/MONGOPORT/...) all work without renaming.
 *
 * Failing here is fatal by design: without a database the bot cannot serve
 * anyone, so we exit non-zero with an actionable message rather than starting a
 * half-working process. Credentials are never logged.
 */
import mongoose from "mongoose";
import { resolveMongoUrl } from "./env.js";

async function connectDB() {
  const resolved = resolveMongoUrl();

  if (!resolved) {
    console.error("");
    console.error("❌ MongoDB is not configured — cannot start.");
    console.error("   Set MONGO_URL (or MONGODB_URI / MONGO_URI / DATABASE_URL),");
    console.error("   or provide MONGOHOST + MONGOPORT + MONGOUSER + MONGOPASSWORD.");
    console.error("   On Railway: Variables → MONGO_URL = ${{MongoDB.MONGO_URL}}");
    console.error("");
    process.exit(1);
  }

  try {
    await mongoose.connect(resolved.url, {
      serverSelectionTimeoutMS: 15000,
    });
    console.log("\x1b[32m%s\x1b[0m", `✔ MongoDB connected successfully (via ${resolved.source})`);
  } catch (err) {
    // err.message may contain the host — never print the full URI (credentials).
    console.error("\x1b[41m\x1b[37m❌ MongoDB connection error:\x1b[0m", err.message);
    console.error(`   Source: ${resolved.source}`);
    console.error("   Check that the database service is running and reachable from this service.");
    process.exit(1);
  }
}

export default connectDB;
