type TextBlock = { type?: unknown; text?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stableHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function stableStringify(value: unknown): string {
  if (!isRecord(value) && !Array.isArray(value)) return String(value);
  try {
    return JSON.stringify(value, (_key, nested) => {
      if (!isRecord(nested) || Array.isArray(nested)) return nested;
      return Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a.localeCompare(b)));
    });
  } catch {
    return String(value);
  }
}

export function getAssistantText(message: unknown): string | null {
  if (!isRecord(message)) return null;
  if (message.role !== "assistant") return null;

  const content = message.content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed ? trimmed : null;
  }

  if (!Array.isArray(content)) return null;
  const text = (content as TextBlock[])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();

  return text || null;
}

export function extractVoiceLineFromText(text: string): string | null {
  const lines = text.split(/\r?\n/);
  const candidates = lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith("🗣️") || line.startsWith("🗣"));

  const last = candidates.at(-1);
  if (!last) return null;

  const cleaned = last
    .replace(/^🗣️?\s*/, "")
    // Optional persona prefix ("Atlas:" / "Themis:") so the name isn't spoken aloud.
    // Single name token, mirroring PAI's parseFinalVoiceLine; lines without a
    // "<Name>:" prefix pass through unchanged.
    .replace(/^\*{0,2}[A-Za-z][A-Za-z0-9_-]*\*{0,2}[ \t]*:\*{0,2}[ \t]*/, "")
    .replace(/^[:\-–—]\s*/, "")
    .trim();

  return isValidVoiceLine(cleaned) ? cleaned : null;
}

export function extractVoiceLineFromMessage(message: unknown): string | null {
  const text = getAssistantText(message);
  return text ? extractVoiceLineFromText(text) : null;
}

function normalizedGenericText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isValidVoiceLine(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 5 || trimmed.length > 500) return false;

  const generic = normalizedGenericText(trimmed);
  if (/^(done|ok|okay|yes|no|sure|ready)$/.test(generic)) return false;
  if (/^(thanks|thank you|youre welcome)$/.test(generic)) return false;
  return true;
}

function scalarIdentity(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function messageIdentity(subject: unknown): string {
  if (isRecord(subject)) {
    const directKeys = ["message_id", "messageId", "id", "uuid", "turn_id", "turnId"];
    for (const key of directKeys) {
      const identity = scalarIdentity(subject[key]);
      if (identity) return `${key}:${identity}`;
    }

    const nested = subject.message;
    if (isRecord(nested)) {
      for (const key of directKeys) {
        const identity = scalarIdentity(nested[key]);
        if (identity) return `message.${key}:${identity}`;
      }
      const text = getAssistantText(nested);
      if (text) return `message.text:${stableHash(text)}`;
    }

    const text = getAssistantText(subject);
    if (text) return `text:${stableHash(text)}`;
  }

  return `json:${stableHash(stableStringify(subject))}`;
}

export function stableMessageKey(sessionId: string, subject: unknown, lineText?: string): string {
  const fingerprint = lineText === undefined
    ? String(subject)
    : `${messageIdentity(subject)}\nline:${lineText}`;
  return `${sessionId}:${stableHash(fingerprint)}`;
}
