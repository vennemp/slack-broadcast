import { DEFAULT_APP_NAME, getAppName } from './branding.js';

export const MAX_CHANNELS = 25;
export const MAX_MESSAGE_LENGTH = 2800;

const plain = (text) => ({ type: 'plain_text', text });
const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });
const base = (title, id) => ({
  type: 'modal', title: plain(title), close: plain('Close'),
  ...(id ? { private_metadata: id } : {}),
});

export function noticeView(text, appName = DEFAULT_APP_NAME) {
  return { ...base('Communications'), blocks: [
    { type: 'context', elements: [plain(appName)] },
    { type: 'section', text: plain(text) },
  ] };
}

export function composeView(draft, appName = DEFAULT_APP_NAME, groups = []) {
  const channels = draft.additionalChannels ?? draft.channels;
  const options = [...groups].sort((a, b) => a.name.localeCompare(b.name)).map((group) => ({
    text: plain(group.name), value: group.id,
    description: plain(`${group.channels.length} channel${group.channels.length === 1 ? '' : 's'}`),
  }));
  const initialOptions = options.filter((option) => draft.savedGroupIds?.includes(option.value));
  return {
    ...base('New broadcast', draft.id),
    callback_id: 'broadcast_compose',
    submit: plain('Review'),
    blocks: [
      { type: 'section', text: plain(`Write once, send to several channels. Messages will appear from ${appName}.`) },
      ...(options.length ? [{
        type: 'input', block_id: 'saved_groups', optional: true, label: plain('Saved channel groups'),
        hint: plain('Choose one or more groups. Review shows every destination; overlapping channels receive one copy.'),
        element: { type: 'multi_static_select', action_id: 'selected', placeholder: plain('Choose saved groups'), options,
          ...(initialOptions.length ? { initial_options: initialOptions } : {}),
        },
      }] : [{ type: 'context', elements: [plain('No saved groups yet. Create one to reuse a set of destination channels.')] }]),
      { type: 'actions', elements: [{ type: 'button', action_id: 'group_manage', text: plain('Manage channel groups'), value: draft.id }] },
      {
        type: 'input', block_id: 'channels', optional: options.length > 0, label: plain(options.length ? 'Additional channels (optional)' : 'Channels'),
        hint: plain(`Up to ${MAX_CHANNELS} total channels across groups and individual selections. Invite ${appName} to each channel first.`),
        element: {
          type: 'multi_conversations_select', action_id: 'selected',
          placeholder: plain('Choose channels'),
          filter: { include: ['public', 'private'] },
          max_selected_items: MAX_CHANNELS,
          ...(channels.length ? { initial_conversations: channels } : {}),
        },
      },
      {
        type: 'input', block_id: 'message', label: plain('Message'),
        hint: plain('Slack formatting: *bold*, _italic_, and links. Link previews are disabled.'),
        element: {
          type: 'plain_text_input', action_id: 'text', multiline: true,
          max_length: MAX_MESSAGE_LENGTH,
          placeholder: plain('What would you like to share?'),
          ...(draft.text ? { initial_value: draft.text } : {}),
        },
      },
    ],
  };
}

export function reviewView(draft, appName = DEFAULT_APP_NAME) {
  return {
    ...base('Review broadcast', draft.id),
    callback_id: 'broadcast_send',
    submit: plain(`Send to ${draft.channels.length}`),
    blocks: [
      { type: 'section', text: plain(`Send as: ${appName}`) },
      section(`*To:* ${draft.channels.map((id) => `<#${id}>`).join(', ')}`),
      ...(draft.skipped?.length ? [
        section(`:warning: *Skipped — ${draft.skipped.length} channel${draft.skipped.length === 1 ? '' : 's'} will not receive this message:*\n${draft.skipped.map((entry) => `• ${entry.label} — ${entry.reason}`).join('\n')}`),
        { type: 'context', elements: [plain('To include them, join each private channel and invite the app, then choose Edit and Review again.')] },
      ] : []),
      { type: 'divider' },
      // verbatim prevents Slack from automatically expanding names in the preview.
      { type: 'section', text: { type: 'mrkdwn', text: draft.text, verbatim: true } },
      { type: 'divider' },
      { type: 'context', elements: [plain('Each channel receives its own copy of this message.')] },
      {
        type: 'actions', elements: [
          { type: 'button', action_id: 'broadcast_edit', text: plain('Edit message or channels'), value: draft.id },
        ],
      },
    ],
  };
}

const failureHelp = {
  not_in_channel: 'Invite the app to this channel, then try this channel again.',
  channel_not_found: 'The app cannot access this channel. Check access and invite it first.',
  is_archived: 'This channel is archived.',
  restricted_action: 'Workspace permissions prevent posting here.',
  restricted_action_read_only_channel: 'This channel only allows certain people to post.',
  missing_scope: 'Reinstall the app with the permissions in manifest.json.',
  ratelimited: 'Slack rate limited this send. Try this channel again later.',
  rate_limited: 'Slack rate limited this send. Try this channel again later.',
  channel_access_denied: 'You or the app no longer have access to this channel. No message was sent here.',
  sender_not_member: 'Skipped: you are not a member of this private channel. No message was sent here.',
  app_not_in_channel: 'Skipped: the app is not in this channel. No message was sent here.',
  sender_not_authorized: 'The sender is no longer authorized to broadcast. No message was sent here.',
};

export function statusView(job, appName = DEFAULT_APP_NAME) {
  const delivered = job.results.filter((result) => result.status === 'sent').length;
  const running = !job.finishedAt;
  return {
    ...base(running ? 'Sending broadcast' : 'Broadcast results', job.id),
    blocks: [
      { type: 'context', elements: [plain(appName)] },
      section(`*${delivered} of ${job.results.length} channels delivered*${running ? ' — sending…' : ''}`),
      ...job.results.map((result) => {
        const target = `<#${result.channel}>`;
        if (result.status === 'sent') return section(`:white_check_mark: ${target} — delivered`);
        if (result.status === 'unknown') return section(`:grey_question: ${target} — delivery unconfirmed. Check the channel before sending again.`);
        if (result.status === 'cancelled') return section(`:no_entry_sign: ${target} — not sent; the broadcast was interrupted before this send began.`);
        if (result.status === 'failed') {
          const code = String(result.error || 'unknown_error').replace(/[^a-zA-Z0-9_]/g, '');
          return section(`:x: ${target} — ${failureHelp[code] || `Slack rejected this send (${code}).`}`);
        }
        return section(`:hourglass_flowing_sand: ${target} — ${result.status === 'sending' ? 'sending' : 'queued'}`);
      }),
      { type: 'context', elements: [plain('Close this dialog any time. Use /broadcast status to see your latest delivery results.')] },
    ],
  };
}
export function createViews(name) {
  const appName = getAppName(name);
  return {
    noticeView: (text) => noticeView(text, appName),
    composeView: (draft, groups) => composeView(draft, appName, groups),
    reviewView: (draft) => reviewView(draft, appName),
    statusView: (job) => statusView(job, appName),
  };
}
