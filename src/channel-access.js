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

export class ChannelAccess {
  constructor(client) { this.client = client; }

  async available(userId) {
    const [botChannels, userPrivateChannels] = await Promise.all([
      memberships(this.client, undefined, 'public_channel,private_channel'),
      memberships(this.client, userId, 'private_channel'),
    ]);
    const privateMemberships = new Set(userPrivateChannels.map((channel) => channel.id));
    return new Set(botChannels
      .filter((channel) => !channel.is_archived && !channel.is_im && !channel.is_mpim)
      .filter((channel) => channel.is_private === false || (channel.is_private === true && privateMemberships.has(channel.id)))
      .map((channel) => channel.id));
  }

  async assert(userId, channels) {
    const allowed = await this.available(userId);
    if (channels.some((id) => !allowed.has(id))) {
      throw new Error('A destination is unavailable. Join private channels and invite the app to every destination before sending.');
    }
    return allowed;
  }
}
