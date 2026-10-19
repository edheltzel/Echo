/**
 * Reader for an Empryo session event log (`transcript_path` in hook payloads).
 *
 * One JSON record per line, keyed by `k`: `meta` (carries `host`: desktop, tui,
 * headless), `tab` (patches, including `openedByAgent` for agent-opened child
 * tabs), `user`, `assistant` (one per turn, final text in `ui.content`), and
 * tool records. Every tab of a session writes to the same log.
 */

export interface EmpryoAssistantTurn {
  tabId?: string;
  turnId?: string;
  text: string;
}

export interface EmpryoSessionLog {
  host?: string;
  lastAssistant?: EmpryoAssistantTurn;
  lastTabId?: string;
  lastUserTurnId?: string;
  agentTabs: Set<string>;
}

type LogRecord = {
  k?: unknown;
  host?: unknown;
  tabId?: unknown;
  turnId?: unknown;
  patch?: { openedByAgent?: unknown };
  ui?: { content?: unknown; segments?: unknown };
};

function assistantText(ui: LogRecord["ui"]): string {
  if (typeof ui?.content === "string") return ui.content;
  if (!Array.isArray(ui?.segments)) return "";
  return ui.segments
    .filter((segment: any) => segment?.type === "text" && typeof segment.content === "string")
    .map((segment: any) => segment.content as string)
    .join("\n");
}

export function parseEmpryoSessionLog(raw: string): EmpryoSessionLog {
  const log: EmpryoSessionLog = { agentTabs: new Set() };
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record: LogRecord;
    try {
      record = JSON.parse(line) as LogRecord;
    } catch {
      // A partial trailing record must not hide the complete ones before it.
      continue;
    }
    const tabId = typeof record.tabId === "string" ? record.tabId : undefined;
    if (record.k === "meta" && typeof record.host === "string") log.host = record.host;
    if (record.k === "tab" && tabId && typeof record.patch?.openedByAgent === "boolean") {
      if (record.patch.openedByAgent) log.agentTabs.add(tabId);
      else log.agentTabs.delete(tabId);
    }
    if (record.k === "user" && typeof record.turnId === "string") log.lastUserTurnId = record.turnId;
    if (record.k === "assistant") {
      log.lastAssistant = {
        tabId,
        turnId: typeof record.turnId === "string" ? record.turnId : undefined,
        text: assistantText(record.ui),
      };
    }
    if (tabId && record.k !== "tab" && record.k !== "tab-close") log.lastTabId = tabId;
  }
  return log;
}

/** The newest prompt has its assistant record, so the turn that just ended is readable. */
export function turnSettled(log: EmpryoSessionLog): boolean {
  if (!log.lastAssistant) return false;
  return log.lastUserTurnId === undefined || log.lastAssistant.turnId === log.lastUserTurnId;
}

export function isChildTab(log: EmpryoSessionLog, tabId: string | undefined): boolean {
  return tabId !== undefined && log.agentTabs.has(tabId);
}
