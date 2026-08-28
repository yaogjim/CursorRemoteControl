/** User-facing copy for Telegram topic/window routing failures. Not part of the Cursor state protocol. */

export type TopicRoutingFailureReason =
  | 'no_thread'
  | 'unmapped_thread'
  | 'window_not_found'
  | 'switch_window_failed'
  | 'switch_tab_failed'
  | 'approval_unroutable'
  | 'questionnaire_unroutable'
  | 'topic_create_failed';

export interface TopicRoutingFailureDetail {
  windowTitle?: string;
  tabTitle?: string;
  threadId?: number;
  error?: string;
  knownWindows?: string[];
}

export function topicRoutingUserMessage(
  reason: TopicRoutingFailureReason,
  detail: TopicRoutingFailureDetail = {},
): string {
  const windowTitle = detail.windowTitle?.trim() || 'unknown';
  const tabTitle = detail.tabTitle?.trim() || 'unknown';
  const err = detail.error?.trim();
  const known = (detail.knownWindows ?? []).filter(Boolean);

  switch (reason) {
    case 'no_thread':
      return '⚠️ Send this inside a mapped forum topic, not General. Run /sync if topics are missing.';
    case 'unmapped_thread':
      return '⚠️ This topic is not mapped to a Cursor window/tab. Run /sync or /sync_all first.';
    case 'window_not_found': {
      const open = known.length > 0 ? known.join(', ') : 'none';
      return `⚠️ Window "${windowTitle}" not found. Open: ${open}`;
    }
    case 'switch_window_failed':
      return err
        ? `⚠️ Failed to switch window: ${err}`
        : '⚠️ Failed to switch to the target window.';
    case 'switch_tab_failed':
      return err
        ? `⚠️ Failed to switch tab "${tabTitle}": ${err}`
        : `⚠️ Failed to switch tab "${tabTitle}".`;
    case 'approval_unroutable':
      return (
        `⚠️ Approval could not be routed to a Telegram topic ` +
        `(window="${windowTitle}", tab="${tabTitle}"). Run /sync, then retry in Cursor.`
      );
    case 'questionnaire_unroutable':
      return (
        `⚠️ Questionnaire could not be routed to a Telegram topic ` +
        `(window="${windowTitle}", tab="${tabTitle}"). Run /sync.`
      );
    case 'topic_create_failed':
      return (
        `⚠️ Could not create a Telegram topic for "${windowTitle} — ${tabTitle}". ` +
        'Check that the group is a forum and the bot can manage topics.'
      );
  }
}

export function topicRoutingLogLine(
  reason: TopicRoutingFailureReason,
  detail: TopicRoutingFailureDetail = {},
): string {
  const parts = [
    `[telegram] Topic routing failed: ${reason}`,
    detail.threadId != null ? `thread=${detail.threadId}` : null,
    detail.windowTitle ? `window="${detail.windowTitle}"` : null,
    detail.tabTitle ? `tab="${detail.tabTitle}"` : null,
    detail.error ? `error=${detail.error}` : null,
  ].filter(Boolean);
  return parts.join(' ');
}