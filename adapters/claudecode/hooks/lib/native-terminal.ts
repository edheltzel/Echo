import { openNativeControllingTty, type TerminalNotificationContext } from "@echo/shared/terminal-notify.ts";

/**
 * Claude hooks receive JSON on stdin and may use stdout for hook protocol
 * output. Open the controlling terminal explicitly; never emit OSC bytes to
 * either hook stream. Failure to open /dev/tty is the normal headless path.
 */
export function createHookNativeVisualContext(
  notificationId?: string,
): TerminalNotificationContext {
  const context: TerminalNotificationContext = { env: process.env, notificationId };
  context.writer = openNativeControllingTty();
  return context;
}
