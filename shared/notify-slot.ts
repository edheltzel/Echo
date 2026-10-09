// Which sound a notification earns when Echo plays sounds instead of speech:
// `request` (an agent needs the operator), `done` (a turn finished), or
// `generic` (everything else). Adapters set it; the daemon treats an omitted
// slot as `generic`, so callers that predate slots keep working.

export const NOTIFY_SLOTS = ["request", "done", "generic"] as const;
export type NotifySlot = (typeof NOTIFY_SLOTS)[number];

export function parseNotifySlot(
  value: unknown,
): { ok: true; slot: NotifySlot | undefined } | { ok: false } {
  if (value === undefined || value === null || value === "") return { ok: true, slot: undefined };
  if (typeof value !== "string") return { ok: false };
  const normalized = value.trim().toLowerCase();
  return (NOTIFY_SLOTS as readonly string[]).includes(normalized)
    ? { ok: true, slot: normalized as NotifySlot }
    : { ok: false };
}
