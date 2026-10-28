import { GroupError, MAX_GROUPS } from './channel-groups.js';

export const selectedGroupIds = (values) => [...new Set((values?.saved_groups?.selected?.selected_options || []).map((option) => option.value))];
export const selectedChannels = (values) => [...new Set(values?.channels?.selected?.selected_conversations || [])];

export async function composeRecipients(values, groups, teamId) {
  const savedGroupIds = selectedGroupIds(values);
  const additionalChannels = selectedChannels(values);
  if (savedGroupIds.length > MAX_GROUPS) throw new GroupError('Choose fewer saved groups.', 'saved_groups');
  const saved = savedGroupIds.length && groups ? await groups.list(teamId) : [];
  const destinations = [...additionalChannels];
  for (const id of savedGroupIds) {
    const group = saved.find((entry) => entry.id === id);
    if (!group) throw new GroupError('A selected group is no longer available. Reopen the composer and choose your groups again.', 'saved_groups');
    destinations.push(...group.channels);
  }
  return { savedGroupIds, additionalChannels, channels: [...new Set(destinations)] };
}
