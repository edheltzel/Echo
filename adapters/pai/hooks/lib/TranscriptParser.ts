#!/usr/bin/env bun
/**
 * TranscriptParser.ts - Claude transcript parsing utilities
 *
 * Shared library for extracting content from Claude Code transcript files.
 * Used by Stop hooks for voice, tab state, and response capture.
 *
 * Vendored into the PAI adapter (atlas-voicesystem) so the adapter owns its
 * Stop-hook pipeline end-to-end. PAI-specific transcript logic — must not live
 * in core/. The only change from the upstream PAI copy is the identity import
 * path (repo-local ./identity instead of the live ~/.claude tree).
 *
 * CLI Usage:
 *   bun TranscriptParser.ts <transcript_path>
 *   bun TranscriptParser.ts <transcript_path> --voice
 *   bun TranscriptParser.ts <transcript_path> --plain
 *   bun TranscriptParser.ts <transcript_path> --structured
 *   bun TranscriptParser.ts <transcript_path> --state
 *
 * Module Usage:
 *   import { parseTranscript, getLastAssistantMessage } from './TranscriptParser'
 */

import { readFileSync } from 'fs';
import { getIdentity } from './identity';

const DA_IDENTITY = getIdentity();

// ============================================================================
// Types
// ============================================================================

export interface StructuredResponse {
  date?: string;
  summary?: string;
  analysis?: string;
  actions?: string;
  results?: string;
  status?: string;
  next?: string;
  completed?: string;
}

export type ResponseState = 'awaitingInput' | 'completed' | 'error';

export interface ParsedTranscript {
  /** Raw transcript content */
  raw: string;
  /** Last assistant message text */
  lastMessage: string;
  /** Full text from current response turn (all assistant blocks combined) */
  currentResponseText: string;
  /** Voice completion text (for TTS) */
  voiceCompletion: string;
  /** Plain completion text (for tab title) */
  plainCompletion: string;
  /** Structured sections extracted from response */
  structured: StructuredResponse;
  /** Response state for tab coloring */
  responseState: ResponseState;
}

// ============================================================================
// Core Parsing Functions
// ============================================================================

/**
 * Safely convert Claude content (string or array of blocks) to plain text.
 */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(c => {
        if (typeof c === 'string') return c;
        if (c?.text) return c.text;
        if (c?.content) return contentToText(c.content);
        return '';
      })
      .join(' ')
      .trim();
  }
  return '';
}

/**
 * Parse last assistant message from transcript content.
 * Takes raw content string to avoid re-reading file.
 */
export function parseLastAssistantMessage(transcriptContent: string): string {
  const lines = transcriptContent.trim().split('\n');
  let lastAssistantMessage = '';

  for (const line of lines) {
    if (line.trim()) {
      try {
        const entry = JSON.parse(line) as any;
        if (entry.type === 'assistant' && entry.message?.content) {
          const text = contentToText(entry.message.content);
          if (text) {
            lastAssistantMessage = text;
          }
        }
      } catch {
        // Skip invalid JSON lines
      }
    }
  }

  return lastAssistantMessage;
}

/**
 * Collect assistant text from the CURRENT response turn only.
 * A "turn" is everything after the last human message in the transcript.
 * This prevents voice/completion extraction from picking up stale lines
 * from previous turns when the Stop hook fires.
 *
 * Within a single turn, there may be multiple assistant entries
 * (text → tool_use → tool_result → more text). All are collected.
 */
export function collectCurrentResponseText(transcriptContent: string): string {
  const lines = transcriptContent.trim().split('\n');

  // Find the index of the last REAL user prompt.
  // Claude Code transcript uses type='user' for both actual user prompts AND
  // tool_result entries (which are mid-response). Real user prompts have at
  // least one {type:'text'} content block. Tool results only have {type:'tool_result'}.
  let lastHumanIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim()) {
      try {
        const entry = JSON.parse(lines[i]) as any;
        if (entry.type === 'human' || entry.type === 'user') {
          const content = entry.message?.content;
          // String content = real user message
          if (typeof content === 'string') {
            lastHumanIndex = i;
          } else if (Array.isArray(content)) {
            // Check for text blocks — indicates a real user prompt
            const hasText = content.some((b: any) => b?.type === 'text' && b?.text?.trim());
            if (hasText) {
              lastHumanIndex = i;
            }
          }
        }
      } catch {
        // Skip invalid JSON lines
      }
    }
  }

  // Collect only assistant text AFTER the last human message
  const textParts: string[] = [];
  for (let i = lastHumanIndex + 1; i < lines.length; i++) {
    if (lines[i].trim()) {
      try {
        const entry = JSON.parse(lines[i]) as any;
        if (entry.type === 'assistant' && entry.message?.content) {
          const text = contentToText(entry.message.content);
          if (text) {
            textParts.push(text);
          }
        }
      } catch {
        // Skip invalid JSON lines
      }
    }
  }

  return textParts.join('\n');
}

/**
 * Get last assistant message from transcript file.
 * Convenience function that reads file and parses.
 */
export function getLastAssistantMessage(transcriptPath: string): string {
  try {
    const content = readFileSync(transcriptPath, 'utf-8');
    return parseLastAssistantMessage(content);
  } catch (error) {
    console.error('[TranscriptParser] Error reading transcript:', error);
    return '';
  }
}

// ============================================================================
// Extraction Functions
// ============================================================================

/** Speaker name and spoken words parsed from a single 🗣️ voice line. */
export interface VoiceLine {
  /** Speaker name exactly as written (original case, markdown stripped). */
  name: string;
  /** Spoken words after the colon (trimmed; a closing bold marker removed). */
  words: string;
}

/**
 * Parse the FINAL real 🗣️ voice line of a response into its speaker name and
 * spoken words. Single source of truth for "who spoke and what they said": both
 * the voice resolver (resolvePersonaKey) and the words extractor
 * (extractVoiceCompletion) consume it, so the chosen voice and the spoken words
 * can never disagree.
 *
 * Line selection matches the locked voice contract: fenced code (``` / ~~~) and
 * indented code blocks are skipped, and only a tag at column 0 of the last
 * non-blank content line counts (a demoed/quoted line never wins). CRLF
 * tolerant. The name grammar is identical to resolvePersonaKey's; the words are
 * everything after the colon, with an optional closing `**` and surrounding
 * whitespace removed.
 *
 * Returns null when the last content line is not a 🗣️ <Name>: voice line.
 * Callers control preprocessing (e.g. stripping <system-reminder> tags).
 */
export function parseFinalVoiceLine(text: string): VoiceLine | null {
  if (!text) return null;

  let fenceChar: string | null = null; // '`' or '~' while inside a fenced block
  let lastContentLine: string | null = null;

  for (const line of text.split('\n')) {
    // A fence delimiter line: up to 3 leading spaces then ≥3 ` or ~ (CommonMark).
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      const ch = fence[1][0];
      if (fenceChar === null) fenceChar = ch;        // open
      else if (fenceChar === ch) fenceChar = null;   // close (same delimiter type)
      continue;                                       // delimiter lines are never content
    }
    if (fenceChar !== null) continue;                 // inside a fenced block → code
    if (/^(?: {4,}|\t)/.test(line)) continue;         // indented code block → code
    if (!line.trim()) continue;                       // blank
    lastContentLine = line;
  }

  if (lastContentLine === null) return null;
  // Column 0 only. The portion up to the colon is byte-identical to the original
  // resolvePersonaKey regex (no end anchor — `.` excludes `\r`, so `(.*)` stops
  // before a CRLF carriage return and a trailing `$` would break CRLF lines).
  const match = lastContentLine.match(
    /^🗣️[ \t]*\*{0,2}([A-Za-z][A-Za-z0-9_-]*)\*{0,2}[ \t]*:\*{0,2}[ \t]*(.*)/,
  );
  if (!match) return null;
  return { name: match[1], words: match[2].trim() };
}

/**
 * Extract voice completion line for TTS — the spoken words of the FINAL 🗣️
 * voice line for ANY speaker (a persona speaks its own words; the DA path is
 * unchanged). Shares parseFinalVoiceLine with the voice resolver so words and
 * voice always agree. Falls back to a 🎯 COMPLETED: marker when no voice line.
 */
export function extractVoiceCompletion(text: string): string {
  // Remove system-reminder tags
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');

  // Primary: the final real 🗣️ voice line (same canonical parse as the voice
  // resolver). Clean up agent tags; voice server handles sanitization.
  const voiceLine = parseFinalVoiceLine(text);
  if (voiceLine) {
    const words = voiceLine.words.replace(/^\[AGENT:\w+\]\s*/i, '').trim();
    if (words) return words;
  }

  // Fallback: a 🎯 COMPLETED: marker (LAST match) when there is no voice line.
  const matches = [...text.matchAll(/🎯\s*\*{0,2}COMPLETED:?\*{0,2}\s*(.+?)(?:\n|$)/gi)];
  const lastMatch = matches[matches.length - 1];
  if (lastMatch && lastMatch[1]) {
    return lastMatch[1].trim().replace(/^\[AGENT:\w+\]\s*/i, '').trim();
  }

  // Don't say anything if no voice line found
  return '';
}

/**
 * Extract plain completion text for display/tab titles.
 * Uses LAST match to avoid capturing mentions in analysis text.
 */
export function extractCompletionPlain(text: string): string {
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');

  // Use global flag and find LAST match (voice line is at end of response)
  const completedPatterns = [
    new RegExp(`🗣️\\s*\\*{0,2}${DA_IDENTITY.name}:?\\*{0,2}\\s*(.+?)(?:\\n|$)`, 'gi'),
    /🎯\s*\*{0,2}COMPLETED:?\*{0,2}\s*(.+?)(?:\n|$)/gi,
  ];

  for (const pattern of completedPatterns) {
    const matches = [...text.matchAll(pattern)];
    if (matches.length > 0) {
      // Use LAST match - the actual voice line at end of response
      const lastMatch = matches[matches.length - 1];
      if (lastMatch && lastMatch[1]) {
        let completed = lastMatch[1].trim();
        completed = completed.replace(/^\[AGENT:\w+\]\s*/i, '');
        completed = completed.replace(/\[.*?\]/g, '');
        completed = completed.replace(/\*\*/g, '');
        completed = completed.replace(/\*/g, '');
        completed = completed.replace(/[\p{Emoji}\p{Emoji_Component}]/gu, '');
        completed = completed.replace(/\s+/g, ' ').trim();
        return completed;
      }
    }
  }

  // Fallback: try to extract something meaningful from the response
  const summaryMatch = text.match(/📋\s*\*{0,2}SUMMARY:?\*{0,2}\s*(.+?)(?:\n|$)/i);
  if (summaryMatch && summaryMatch[1]) {
    let summary = summaryMatch[1].trim().slice(0, 30);
    return summary.length > 27 ? summary.slice(0, 27) + '…' : summary;
  }

  // No voice line found — return empty, let downstream handle fallback
  return '';
}

/**
 * Extract structured sections from response.
 */
export function extractStructuredSections(text: string): StructuredResponse {
  const result: StructuredResponse = {};

  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');

  const patterns: Record<keyof StructuredResponse, RegExp> = {
    date: /📅\s*(.+?)(?:\n|$)/i,
    summary: /📋\s*SUMMARY:\s*(.+?)(?:\n|$)/i,
    analysis: /🔍\s*ANALYSIS:\s*(.+?)(?:\n|$)/i,
    actions: /⚡\s*ACTIONS:\s*(.+?)(?:\n|$)/i,
    results: /✅\s*RESULTS:\s*(.+?)(?:\n|$)/i,
    status: /📊\s*STATUS:\s*(.+?)(?:\n|$)/i,
    next: /➡️\s*NEXT:\s*(.+?)(?:\n|$)/i,
    completed: new RegExp(`(?:🗣️\\s*${DA_IDENTITY.name}:|🎯\\s*COMPLETED:)\\s*(.+?)(?:\\n|$)`, 'i'),
  };

  for (const [key, pattern] of Object.entries(patterns)) {
    const match = text.match(pattern);
    if (match && match[1]) {
      result[key as keyof StructuredResponse] = match[1].trim();
    }
  }

  return result;
}

// ============================================================================
// State Detection
// ============================================================================

/**
 * Detect response state for tab coloring.
 * Takes parsed content to avoid re-reading file.
 */
export function detectResponseState(lastMessage: string, transcriptContent: string): ResponseState {
  try {
    // Check if the LAST assistant message used AskUserQuestion
    const lines = transcriptContent.trim().split('\n');
    let lastAssistantEntry: any = null;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'assistant' && entry.message?.content) {
          lastAssistantEntry = entry;
        }
      } catch {}
    }

    if (lastAssistantEntry?.message?.content) {
      const content = Array.isArray(lastAssistantEntry.message.content)
        ? lastAssistantEntry.message.content
        : [];
      for (const block of content) {
        if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
          return 'awaitingInput';
        }
      }
    }
  } catch (err) {
    console.error('[TranscriptParser] Error detecting response state:', err);
  }

  // Check for error indicators
  if (/📊\s*STATUS:.*(?:error|failed|broken|problem|issue)/i.test(lastMessage)) {
    return 'error';
  }

  const hasErrorKeyword = /\b(?:error|failed|exception|crash|broken)\b/i.test(lastMessage);
  const hasErrorEmoji = /❌|🚨|⚠️/.test(lastMessage);
  if (hasErrorKeyword && hasErrorEmoji) {
    return 'error';
  }

  return 'completed';
}

// ============================================================================
// Unified Parser
// ============================================================================

/**
 * Parse transcript and extract all relevant data in one pass.
 * This is the main function for the orchestrator pattern.
 */
export function parseTranscript(transcriptPath: string): ParsedTranscript {
  try {
    const raw = readFileSync(transcriptPath, 'utf-8');
    const lastMessage = parseLastAssistantMessage(raw);
    // Collect assistant text from CURRENT response turn only.
    // This prevents stale voice lines from previous turns being read
    // when the Stop hook fires. Within the current turn, multiple
    // assistant entries exist (text → tool_use → tool_result → more text).
    const currentResponseText = collectCurrentResponseText(raw);

    return {
      raw,
      lastMessage,
      currentResponseText,
      voiceCompletion: extractVoiceCompletion(currentResponseText),
      plainCompletion: extractCompletionPlain(currentResponseText),
      structured: extractStructuredSections(currentResponseText),
      responseState: detectResponseState(lastMessage, raw),
    };
  } catch (error) {
    console.error('[TranscriptParser] Error parsing transcript:', error);
    return {
      raw: '',
      lastMessage: '',
      currentResponseText: '',
      voiceCompletion: '',
      plainCompletion: '',
      structured: {},
      responseState: 'completed',
    };
  }
}

// ============================================================================
// CLI
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  const transcriptPath = args.find(a => !a.startsWith('-'));

  if (!transcriptPath) {
    console.log(`Usage: bun TranscriptParser.ts <transcript_path> [options]

Options:
  --voice       Output voice completion (for TTS)
  --plain       Output plain completion (for tab titles)
  --structured  Output structured sections as JSON
  --state       Output response state
  --all         Output full parsed transcript as JSON (default)
`);
    process.exit(1);
  }

  const parsed = parseTranscript(transcriptPath);

  if (args.includes('--voice')) {
    console.log(parsed.voiceCompletion);
  } else if (args.includes('--plain')) {
    console.log(parsed.plainCompletion);
  } else if (args.includes('--structured')) {
    console.log(JSON.stringify(parsed.structured, null, 2));
  } else if (args.includes('--state')) {
    console.log(parsed.responseState);
  } else {
    // Default: output everything
    console.log(JSON.stringify(parsed, null, 2));
  }
}
