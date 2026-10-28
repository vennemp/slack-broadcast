const plain = (text) => ({ type: 'plain_text', text });
const button = (id, text, value = 'none') => ({ type: 'button', action_id: id, text: plain(text), value });
const base = (title) => ({ type: 'modal', title: plain(title), close: plain('Close') });

export const SENDER_ACTIONS = ['home_senders', 'senders_add', 'senders_remove', 'senders_list'];

export async function senderListView(senders, teamId) {
  const policy = await senders.policy(teamId);
  return {
    ...base('Approved senders'),
    blocks: [
      { type: 'section', text: plain('Approved senders can compose broadcasts and manage shared channel groups. App administrators are controlled by the deployment configuration.') },
      { type: 'actions', elements: [button('senders_add', 'Add approved sender')] },
      ...[...policy.allowed].map((id) => ({
        type: 'section', text: { type: 'mrkdwn', text: `<@${id}>` },
        accessory: { ...button('senders_remove', 'Remove', id), confirm: {
          title: plain('Remove sending access?'), text: plain('This prevents future broadcasts and shared-group changes. Already posted messages remain in Slack.'), confirm: plain('Remove access'), deny: plain('Keep access'),
        } },
      })),
      ...(!policy.allowed.size ? [{ type: 'section', text: plain('No senders are approved. Add someone to enable broadcasting.') }] : []),
    ],
  };
}

function addSenderView() {
  return {
    ...base('Add approved sender'), callback_id: 'sender_save', submit: plain('Approve sender'),
    blocks: [
      { type: 'input', block_id: 'sender', label: plain('Workspace member'), element: { type: 'users_select', action_id: 'user', placeholder: plain('Choose a person') } },
      { type: 'section', text: plain('They will be able to send broadcasts and create or edit shared channel groups. This does not grant private channel membership or app administrator access.') },
      { type: 'actions', elements: [button('senders_list', 'Back to approved senders')] },
    ],
  };
}

export async function handleSenderManagement(payload, { senders, teamId, client }) {
  const action = payload.actions?.[0];
  const submission = payload.type === 'view_submission' && payload.view?.callback_id === 'sender_save';
  if (!submission && !SENDER_ACTIONS.includes(action?.action_id)) return null;
  const actor = payload.user?.id;
  if (payload.team?.id !== teamId) throw new Error('Workspace mismatch');
  const policy = await senders.policy(teamId);
  if (!policy.admins.has(actor)) throw new Error('Only app administrators can manage approved senders');
  if (submission) {
    const userId = payload.view.state?.values?.sender?.user?.selected_user;
    if (!/^[UW][A-Z0-9]+$/.test(userId || '')) return { response_action: 'errors', errors: { sender: 'Choose a workspace member.' } };
    await senders.change(teamId, { actor, operation: 'add', userId });
    return { response_action: 'update', view: await senderListView(senders, teamId) };
  }
  if (action.action_id === 'home_senders') {
    await client.views.open({ trigger_id: payload.trigger_id, view: await senderListView(senders, teamId) });
    return {};
  }
  if (action.action_id === 'senders_remove') await senders.change(teamId, { actor, operation: 'remove', userId: action.value });
  const view = action.action_id === 'senders_add' ? addSenderView() : await senderListView(senders, teamId);
  await client.views.update({ view_id: payload.view.id, hash: payload.view.hash, view });
  return {};
}
