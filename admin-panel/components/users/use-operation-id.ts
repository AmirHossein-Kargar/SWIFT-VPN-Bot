"use client";

import { useCallback, useState } from "react";

import { newOperationId } from "@/lib/adminApi.client";

/**
 * One operationId per dialog session. Retrying after a timeout or network
 * error re-sends the SAME id, so the server's idempotency guard (audit log +
 * appliedAdminBalanceKeys) dedupes it instead of applying the action twice.
 * Call rotate() only after a confirmed success, before the next action.
 */
export function useOperationId() {
  const [operationId, setOperationId] = useState(newOperationId);
  const rotate = useCallback(() => setOperationId(newOperationId()), []);
  return { operationId, rotate };
}
