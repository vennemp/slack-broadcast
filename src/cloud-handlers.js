import { createViews, MAX_CHANNELS, MAX_MESSAGE_LENGTH } from './views.js';
import { createGroupHandler } from './group-handlers.js';
import { ChannelAccess } from './channel-access.js';
import { homeView } from './home-view.js';
import { handleSenderManagement, SENDER_ACTIONS } from './sender-management.js';
import { composeRecipients, selectedChannels, selectedGroupIds } from './compose-groups.js';
import { GroupError } from './channel-groups.js';

const updated = (view) => ({ response_action: 'update', view });

export function cloudStatusView(job, appName) {
  const view = createViews(appName).statusView(job);
  view.blocks.push({
    type: 'actions', elements: [{
      type: 'button', action_id: 'broadcast_refresh', value: job.id,
      text: { type: 'plain_text', text: 'Refresh results' },
    }],
  });
  return view;
}

// Complete all work before returning the HTTP acknowledgement. Delivery itself
// is a separate Cloud Tasks request, so no CPU is needed after responding.
export function createCloudHandler({ store, queue, client, teamId, allowedUsers = new Set(), appName, groups, senders, access = new ChannelAccess(client) }) {
  const { composeView: renderCompose, reviewView, noticeView } = createViews(appName);
  const composeView = async (draft) => renderCompose(draft, groups ? await groups.list(teamId) : []);
  const unavailable = () => updated(noticeView('This draft is unavailable or expired. Run /broadcast to start again.'));
  const groupHandler = groups ? createGroupHandler({
    groups, access, client, teamId, appName,
    stashDraft: async (payload) => {
      const draft = await store.changeDraft(payload.view.private_metadata, teamId, payload.user.id, 'compose', {
        text: payload.view.state?.values?.message?.text?.value || '',
        channels: selectedChannels(payload.view.state?.values),
        additionalChannels: selectedChannels(payload.view.state?.values),
        savedGroupIds: selectedGroupIds(payload.view.state?.values),
      });
      if (!draft) throw new Error('Draft unavailable');
      return draft.id;
    },
    compose: async ({ userId, channels, draftId }) => {
      let draft = draftId ? await store.draft(draftId, teamId, userId) : undefined;
      if (draft?.state !== 'compose') draft = undefined;
      if (!draft) draft = await store.createDraft({ teamId, userId });
      if (channels) draft = await store.changeDraft(draft.id, teamId, userId, 'compose', { channels, additionalChannels: channels, savedGroupIds: [] });
      return composeView(draft);
    },
  }) : undefined;

  return async function handle(payload) {
    // Slack signs this one-time endpoint verification request; it has no user.
    if (payload.type === 'url_verification') return { challenge: payload.challenge };
    const workspace = payload.team_id || payload.team?.id;
    const userId = payload.user_id || payload.user?.id || payload.event?.user;
    const policy = workspace === teamId && senders ? await senders.policy(teamId) : undefined;
    const permitted = (id) => policy ? policy.allowed.has(id) : (!allowedUsers.size || allowedUsers.has(id));
    const isAdmin = !!policy?.admins.has(userId);
    if (payload.type === 'event_callback') {
      if (workspace === teamId && payload.event?.type === 'app_home_opened' && payload.event.tab === 'home') {
        const authorized = !!userId && permitted(userId);
        await client.views.publish({ user_id: userId, view: homeView({ appName, authorized, isAdmin, jobs: authorized ? await store.recent(teamId, userId) : [] }) });
      }
      return {};
    }
    const senderRequest = SENDER_ACTIONS.includes(payload.actions?.[0]?.action_id) || (payload.type === 'view_submission' && payload.view?.callback_id === 'sender_save');
    if (workspace === teamId && isAdmin && senderRequest) return handleSenderManagement(payload, { senders, teamId, client });
    if (senderRequest && !isAdmin) {
      if (payload.type === 'view_submission') return updated(noticeView('Only app administrators can manage approved senders.'));
      return {};
    }
    if (workspace !== teamId || !userId || !permitted(userId)) {
      return payload.command
        ? { response_type: 'ephemeral', text: `You do not have access to use ${appName}.` }
        : updated(noticeView('You do not have access to use this app.'));
    }
    const homeAction = payload.actions?.[0];
    if (payload.type === 'block_actions' && homeAction?.action_id.startsWith('home_')) {
      if (homeAction.action_id === 'home_refresh') {
        await client.views.publish({ user_id: userId, view: homeView({ appName, authorized: true, isAdmin, jobs: await store.recent(teamId, userId) }) });
      } else if (homeAction.action_id === 'home_compose') {
        const draft = await store.createDraft({ teamId, userId });
        await client.views.open({ trigger_id: payload.trigger_id, view: await composeView(draft) });
      } else if (homeAction.action_id === 'home_groups' && groupHandler) {
        await groupHandler({ command: '/broadcast', text: 'groups', team_id: teamId, user_id: userId, trigger_id: payload.trigger_id });
      } else if (homeAction.action_id === 'home_results') {
        const job = await store.job(homeAction.value, teamId, userId);
        await client.views.open({ trigger_id: payload.trigger_id, view: job ? cloudStatusView(job, appName) : noticeView('This receipt has expired or is unavailable.') });
      }
      return {};
    }
    if (groupHandler) {
      const groupResponse = await groupHandler(payload);
      if (groupResponse !== null) return groupResponse;
    }
    if (payload.command === '/broadcast') {
      const text = payload.text || '';
      let view;
      if (text.trim().toLowerCase() === 'status') {
        const job = await store.latest(teamId, userId);
        view = job ? cloudStatusView(job, appName) : noticeView('No delivery results yet. Run /broadcast to compose a message.');
      } else {
        if (text.length > MAX_MESSAGE_LENGTH) return { response_type: 'ephemeral', text: `Messages can contain up to ${MAX_MESSAGE_LENGTH} characters.` };
        const draft = await store.createDraft({ teamId, userId, text });
        view = await composeView(draft);
      }
      await client.views.open({ trigger_id: payload.trigger_id, view });
      return {};
    }
    if (payload.type === 'block_actions') {
      const action = payload.actions?.[0];
      if (action?.action_id === 'broadcast_refresh') {
        const job = await store.job(action.value, teamId, userId);
        if (job) await client.views.update({ view_id: payload.view.id, hash: payload.view.hash, view: cloudStatusView(job, appName) });
      } else if (action?.action_id === 'broadcast_edit') {
        const id = payload.view?.private_metadata;
        const draft = await store.changeDraft(id, teamId, userId, 'review', { state: 'compose' });
        if (draft) {
          try {
            await client.views.update({ view_id: payload.view.id, hash: payload.view.hash, view: await composeView(draft) });
          } catch (error) {
            await store.changeDraft(id, teamId, userId, 'compose', { state: 'review' });
            throw error;
          }
        }
      }
      return {};
    }
    if (payload.type !== 'view_submission') return {};
    const view = payload.view;
    if (!view) return unavailable();
    if (view.callback_id === 'broadcast_compose') {
      let recipients;
      try { recipients = await composeRecipients(view.state?.values, groups, teamId); }
      catch (error) {
        if (error instanceof GroupError) return { response_action: 'errors', errors: { [error.field]: error.message } };
        throw error;
      }
      const { channels } = recipients;
      const text = view.state?.values?.message?.text?.value || '';
      const errors = {};
      if (!channels.length || channels.length > MAX_CHANNELS || channels.some((id) => !/^[CG][A-Z0-9]+$/.test(id))) errors.channels = `Choose between 1 and ${MAX_CHANNELS} channels.`;
      if (!text.trim() || text.length > MAX_MESSAGE_LENGTH) errors.message = `Enter a message of 1 to ${MAX_MESSAGE_LENGTH} characters.`;
      if (Object.keys(errors).length) return { response_action: 'errors', errors };
      try { await access.assert(userId, channels); }
      catch { return { response_action: 'errors', errors: { channels: 'Could not verify every destination. Join private channels and invite the app, then try again.' } }; }
      const draft = await store.changeDraft(view.private_metadata, teamId, userId, 'compose', { state: 'review', ...recipients, text });
      if (draft) return updated(reviewView(draft));
      // A retry may arrive after the first request saved the review state.
      const existing = await store.draft(view.private_metadata, teamId, userId);
      return existing?.state === 'review' ? updated(reviewView(existing)) : unavailable();
    }
    if (view.callback_id === 'broadcast_send') {
      const draft = await store.draft(view.private_metadata, teamId, userId);
      if (!draft) return unavailable();
      try { await access.assert(userId, draft.channels); }
      catch { return updated(noticeView('Channel access could not be verified. Run /broadcast to check your destinations again.')); }
      const job = await store.prepare(view.private_metadata, teamId, userId, view.id);
      if (!job) return unavailable();
      if (!job.finishedAt) {
        try {
          await queue.enqueue(job.id);
        } catch {
          const retryView = reviewView({ id: job.id, channels: job.results.map((result) => result.channel), text: job.text });
          retryView.blocks.unshift({ type: 'section', text: { type: 'plain_text', text: 'Could not confirm queueing. Click Send again to check or retry this same broadcast safely.' } });
          return updated(retryView);
        }
      }
      return updated(cloudStatusView(job, appName));
    }
    return {};
  };
}
