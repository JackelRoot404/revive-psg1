import { randomUUID } from "node:crypto";
import type { Database } from "./db/client";
import { auditEvents } from "./db/schema";
import { sha256 } from "./security";

export async function audit(db: Database, eventType: string, input: {
  actor?: string;
  subjectId?: string;
  payload?: Record<string, unknown>;
} = {}): Promise<void> {
  await db.insert(auditEvents).values({
    id: randomUUID(),
    eventType,
    actorHash: input.actor ? sha256(`audit:v1:${input.actor}`) : null,
    subjectId: input.subjectId,
    payload: input.payload ?? {}
  });
}
