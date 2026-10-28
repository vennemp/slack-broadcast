async function memberships(client, user, types) {
  const channels = [];
  let cursor;
  for (let page = 0; page < 20; page += 1) {
    const response = await client.users.conversations({
      types, exclude_archived: true, limit: 999,
      ...(user ? { user } : {}), ...(cursor ? { cursor } : {}),
    });
    if (!response.ok) throw new Error('Could not verify channel access');
    channels.push(...(response.channels || []));
    cursor = response.response_metadata?.next_cursor;
    if (!cursor) return channels;
  }
  throw new Error('Channel membership inventory exceeded its page limit');
}

export function blockedText(skipped) {
  const shown = skipped.slice(0, 10).map((entry) => `${entry.label} (${entry.reason})`);
  if (skipped.length > shown.length) shown.push(`and ${skipped.length - shown.length} more`);
  return shown.join(', ');
}

export class ChannelAccess {
  constructor(client) { this.client = client; }

  async inventory(userId) {
    const [botChannels, userPrivateChannels] = await Promise.all([
      memberships(this.client, undefined, 'public_channel,private_channel'),
      memberships(this.client, userId, 'private_channel'),
    ]);
    const privateMemberships = new Set(userPrivateChannels.map((channel) => channel.id));
    const usable = botChannels.filter((channel) => !channel.is_archived && !channel.is_im && !channel.is_mpim);
    const allowed = new Set(usable
      .filter((channel) => channel.is_private === false || (channel.is_private === true && privateMemberships.has(channel.id)))
      .map((channel) => channel.id));
    return { allowed, botChannels: new Map(usable.map((channel) => [channel.id, channel])) };
  }

  async available(userId) {
    return (await this.inventory(userId)).allowed;
  }

  async describe(channel, botChannels) {
    const known = botChannels.get(channel);
    if (known) return { channel, label: known.name ? `#${known.name}` : channel, reason: 'you are not a member of this private channel', error: 'sender_not_member' };
    const missingApp = { reason: 'the app is not in this channel', error: 'app_not_in_channel' };
    try {
      const { channel: info } = await this.client.conversations.info({ channel });
      return { channel, label: info?.name ? `#${info.name}` : channel, ...missingApp };
    } catch {
      // The bot cannot see private channels it has not been invited to.
      return { channel, label: `private channel ${channel}`, ...missingApp };
    }
  }

  // Splits destinations into those this sender may post to and those to skip, with reasons.
  async check(userId, channels) {
    const { allowed, botChannels } = await this.inventory(userId);
    const blocked = channels.filter((id) => !allowed.has(id));
    return {
      channels: channels.filter((id) => allowed.has(id)),
      skipped: await Promise.all(blocked.map((id) => this.describe(id, botChannels))),
    };
  }
}
