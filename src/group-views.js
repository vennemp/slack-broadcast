import { MAX_GROUP_CHANNELS, MAX_GROUP_NAME } from './channel-groups.js';

const plain = (text) => ({ type: 'plain_text', text });
const button = (id, text, value = 'none') => ({ type: 'button', action_id: id, text: plain(text), value });
const base = (title, metadata) => ({ type: 'modal', title: plain(title), close: plain('Close'), private_metadata: JSON.stringify(metadata) });

export function groupListView(groups, appName, draftId) {
  return {
    ...base('Shared channel groups', { draftId }),
    blocks: [
      { type: 'context', elements: [plain(appName)] },
      { type: 'section', text: plain('Groups are shared by the authorized senders. Group members are channels; Slack channel access is checked separately.') },
      { type: 'context', elements: [plain('Choose ⋯ beside a group to view/edit its channels or use it for a message.')] },
      { type: 'actions', elements: [button('group_new', 'Create group'), button('group_compose', draftId ? 'Back to message' : 'Compose message')] },
      ...groups.map((group) => ({
        type: 'section', text: plain(`${group.name}\n${group.channels.length} channel${group.channels.length === 1 ? '' : 's'}`),
        accessory: {
          type: 'overflow', action_id: 'group_choice', options: [
            { text: plain('View / edit channels'), value: `${group.id}:edit` },
            { text: plain('Use for message'), value: `${group.id}:use` },
          ],
        },
      })),
      ...(!groups.length ? [{ type: 'section', text: plain('No groups yet. Create one to reuse a set of destinations.') }] : []),
    ],
  };
}

export function groupEditView(group, available, appName, draftId) {
  const visible = (group?.channels || []).filter((id) => available.has(id));
  const hiddenCount = (group?.channels.length || 0) - visible.length;
  const metadata = { id: group?.id, version: group?.version || 0, draftId };
  return {
    ...base(group ? 'Edit channel group' : 'Create channel group', metadata),
    callback_id: 'group_save', submit: plain('Save group'),
    blocks: [
      { type: 'context', elements: [plain(appName)] },
      { type: 'input', block_id: 'group_name', label: plain('Group name'), element: { type: 'plain_text_input', action_id: 'name', max_length: MAX_GROUP_NAME, ...(group ? { initial_value: group.name } : {}), placeholder: plain('For example, Engineering updates') } },
      ...(visible.length ? [{ type: 'section', text: { type: 'mrkdwn', text: `*Current channels:* ${visible.map((id) => `<#${id}>`).join(', ')}` } }] : []),
      ...(hiddenCount ? [{ type: 'section', text: plain(`${hiddenCount} existing channel(s) are unavailable to you or the app. They will be preserved when you save; someone with access can edit them.`) }] : []),
      {
        type: 'input', block_id: 'group_channels', label: plain('Channels'), optional: hiddenCount > 0,
        hint: plain('Add channels with the picker; remove one with its ×. Join private channels and invite the app before adding them.'),
        element: {
          type: 'multi_conversations_select', action_id: 'channels', filter: { include: ['public', 'private'] },
          max_selected_items: MAX_GROUP_CHANNELS, placeholder: plain('Choose channels'),
          ...(visible.length ? { initial_conversations: visible } : {}),
        },
      },
      {
        type: 'actions', elements: [button('group_list', 'Back to groups'), ...(group ? [{
          ...button('group_delete', 'Delete group', JSON.stringify({ id: group.id, version: group.version })), style: 'danger',
          confirm: { title: plain('Delete shared group?'), text: plain('This removes the saved group for all authorized senders. Slack channels and posted messages are unaffected.'), confirm: plain('Delete group'), deny: plain('Keep group') },
        }] : [])],
      },
    ],
  };
}

export function groupNoticeView(text, appName, draftId) {
  return {
    ...base('Channel groups', { draftId }),
    blocks: [
      { type: 'context', elements: [plain(appName)] }, { type: 'section', text: plain(text) },
      { type: 'actions', elements: [button('group_list', 'Back to groups')] },
    ],
  };
}
