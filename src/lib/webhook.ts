import type { SentinelAlert } from '../types.js';

export async function sendSlackWebhook(
  webhookUrl: string,
  alert: SentinelAlert,
): Promise<boolean> {
  if (!webhookUrl) return false;

  const deltaLine = alert.stateDeltaNote ? `\n*Update:* ${alert.stateDeltaNote}` : '';
  const text = `🚨 *[STRATEMARK Sentinel Alert]* *${alert.companyName}* — ${alert.changeType}\n*Summary:* ${alert.summary}${deltaLine}\n*Source:* ${alert.sourceUrl ? `<${alert.sourceUrl}|${alert.sourceTitle}>` : 'N/A'}`;

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function sendDiscordWebhook(
  webhookUrl: string,
  alert: SentinelAlert,
): Promise<boolean> {
  if (!webhookUrl) return false;

  const deltaLine = alert.stateDeltaNote ? `\n**Update:** ${alert.stateDeltaNote}` : '';
  const content = `🚨 **[STRATEMARK Sentinel Alert]** **${alert.companyName}** — ${alert.changeType}\n**Summary:** ${alert.summary}${deltaLine}\n**Source:** ${alert.sourceUrl ? `[${alert.sourceTitle}](${alert.sourceUrl})` : 'N/A'}`;

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
