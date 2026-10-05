import "dotenv/config";
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import cleanupLegacyPhoneData from "../services/migrations/cleanupLegacyPhoneData.js";

try {
  await connectDB();
  const result = await cleanupLegacyPhoneData();
  console.log(`Legacy contact-field cleanup complete: ${result.modifiedDocuments} document(s) updated.`);
} catch (error) {
  console.error(`Legacy contact-field cleanup failed (${error?.name || "DatabaseError"}).`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}
