"use client";

import { useEffect, useState } from "react";
import { alertItems, mergeAlertLog, type AlertLog } from "@/lib/inbox/alerts";
import type { InboxResponse } from "@/lib/inbox/types";

const LOG_KEY = "finn.alerts.v1";

function readLog(): AlertLog {
  try {
    const raw = window.localStorage.getItem(LOG_KEY);
    return raw ? (JSON.parse(raw) as AlertLog) : {};
  } catch {
    return {};
  }
}

function writeLog(log: AlertLog) {
  try {
    window.localStorage.setItem(LOG_KEY, JSON.stringify(log));
  } catch {
    // Storage blocked: alerts still show; "new" marks just won't survive a reload.
  }
}

/**
 * Which alerts this device is seeing for the first time. Marks stay for the rest of the visit,
 * so switching windows or refreshing never turns a new alert into a seen one mid-read.
 */
export function useAlertLog(data: InboxResponse | undefined): { fresh: ReadonlySet<string>; log: AlertLog } {
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [log, setLog] = useState<AlertLog>({});

  useEffect(() => {
    if (!data || data.dataMode === "sample") return;
    const { log: next, fresh: firstSeen } = mergeAlertLog(readLog(), alertItems(data.items).map((i) => i.id), Date.now());
    writeLog(next);
    // Recording the alerts a response brought is the intended post-render update.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLog(next);
    if (firstSeen.size) setFresh((prev) => new Set([...prev, ...firstSeen]));
  }, [data]);

  return { fresh, log };
}
