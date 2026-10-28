import { groupListView, groupEditView, groupNoticeView } from './group-views.js';
import { GroupError } from './channel-groups.js';

export const GROUP_ACTIONS = ['group_new', 'group_compose', 'group_choice', 'group_list', 'group_delete', 'group_manage'];

export function createGroupHandler({ groups, access, client, teamId, appName, stashDraft, compose }) {
  return async function handle(payload) {
    const command = payload.command === '/broadcast' && payload.text?.trim().toLowerCase() === 'groups';
    const action = payload.actions?.[0];
    const submission = payload.type === 'view_submission' && payload.view?.callback_id === 'group_save';
    if (!command && !GROUP_ACTIONS.includes(action?.action_id) && !submission) return null;
    const userId = payload.user_id || payload.user?.id;
    let metadata = {};
    // Composer metadata is a draft UUID; group views use a JSON object.
    try { metadata = JSON.parse(payload.view?.private_metadata || '{}'); } catch { /* Composer draft metadata. */ }
    const draftId = metadata.draftId;
    const list = async (id = draftId) => groupListView(await groups.list(teamId), appName, id);
    const update = async (view) => {
      await client.views.update({ view_id: payload.view.id, hash: payload.view.hash, view });
      return {};
    };
    try {
      if (command) {
        await client.views.open({ trigger_id: payload.trigger_id, view: await list() });
        return {};
      }
      if (submission) {
        const available = await access.available(userId);
        const existing = metadata.id ? await groups.get(teamId, metadata.id) : undefined;
        if (metadata.id && !existing) throw new GroupError('This group was removed. Reopen the group list.');
        const selected = [...new Set(payload.view.state?.values?.group_channels?.channels?.selected_conversations || [])];
        if (selected.some((id) => !available.has(id))) throw new GroupError('A selected channel is unavailable. Join private channels and invite the app to each destination.', 'group_channels');
        const preserved = (existing?.channels || []).filter((id) => !available.has(id));
        await groups.save(teamId, {
          id: metadata.id, version: metadata.version, userId,
          name: payload.view.state?.values?.group_name?.name?.value,
          channels: [...preserved, ...selected],
        });
        return { response_action: 'update', view: await list() };
      }
      if (action.action_id === 'group_manage') return update(await list(await stashDraft(payload)));
      if (action.action_id === 'group_list') return update(await list());
      if (action.action_id === 'group_compose') return update(await compose({ userId, draftId }));
      if (action.action_id === 'group_new') return update(groupEditView(undefined, new Set(), appName, draftId));
      if (action.action_id === 'group_delete') {
        const mutation = JSON.parse(action.value);
        await groups.save(teamId, { ...mutation, userId, operation: 'delete' });
        return update(await list());
      }
      if (action.action_id === 'group_choice') {
        const [id, operation] = (action.selected_option?.value || '').split(':');
        const group = await groups.get(teamId, id);
        if (!group) return update(groupNoticeView('This group was removed. Reopen the group list.', appName, draftId));
        const available = await access.available(userId);
        if (operation === 'edit') return update(groupEditView(group, available, appName, draftId));
        if (operation === 'use') {
          if (!group.channels.some((channel) => available.has(channel))) return update(groupNoticeView('You or the app cannot access any channel in this group. Join its private channels and invite the app before using it. No message has been sent.', appName, draftId));
          // Select the group itself; Review lists any of its channels that will be skipped.
          return update(await compose({ userId, groupId: group.id, draftId }));
        }
      }
      return {};
    } catch (error) {
      if (submission && error instanceof GroupError) return { response_action: 'errors', errors: { [error.field]: error.message } };
      if (error instanceof GroupError) return update(groupNoticeView(error.message, appName, draftId));
      throw error;
    }
  };
}
