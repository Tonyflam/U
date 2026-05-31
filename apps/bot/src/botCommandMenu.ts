/**
 * Registers the bot's slash-command menu with Telegram via setMyCommands.
 *
 * This populates the blue "Menu" button next to the Telegram input box so
 * users discover commands without having to read /help. Telegram caches
 * the list per-bot, so we re-publish on every boot — cheap and idempotent.
 *
 * Descriptions must be 1-256 chars; keep them short, no leading slash.
 */
import type { Api } from 'grammy';

export const BOT_COMMAND_MENU: ReadonlyArray<{ readonly command: string; readonly description: string }> = [
  { command: 'whales', description: 'Browse traders you can copy' },
  { command: 'follow', description: 'Start copying a trader: /follow 0xabc... 50' },
  { command: 'mirrors', description: 'List everyone you are copying' },
  { command: 'setcap', description: 'Change a per-trade size cap: /setcap 0xabc... 100' },
  { command: 'tp', description: 'Set take-profit in bps: /tp 0xabc... 200' },
  { command: 'sl', description: 'Set stop-loss in bps: /sl 0xabc... 100' },
  { command: 'unfollow', description: 'Stop copying a trader: /unfollow 0xabc...' },
  { command: 'close', description: 'Close one open position: /close ETH' },
  { command: 'closeall', description: 'Close every open position' },
  { command: 'pnl', description: 'Profit & loss across your mirrors' },
  { command: 'wallet', description: 'Show wallet, agent, and fee' },
  { command: 'pause', description: 'Temporarily stop ALL copying' },
  { command: 'resume', description: 'Resume copying' },
  { command: 'kill', description: 'Emergency stop (active until /unkill)' },
  { command: 'unkill', description: 'Clear the emergency stop' },
  { command: 'notify', description: 'Manage fill alerts: on / off / compact / full' },
  { command: 'leaderboard', description: 'Top WhalePod users this week' },
  { command: 'share', description: 'Your personal invite link' },
  { command: 'disconnect', description: 'Remove wallet and revoke the agent' },
  { command: 'help', description: 'Show all commands with examples' },
];

export async function registerBotCommands(api: Pick<Api, 'setMyCommands'>): Promise<void> {
  await api.setMyCommands(BOT_COMMAND_MENU.map((c) => ({ command: c.command, description: c.description })));
}
