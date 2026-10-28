import { randomUUID } from 'node:crypto';
import { deliver } from './delivery.js';
import { createViews, MAX_CHANNELS, MAX_MESSAGE_LENGTH } from './views.js';
import { getAppName } from './branding.js';
import { LocalGroups } from './channel-groups.js';
import { ChannelAccess } from './channel-access.js';
import { createGroupHandler, GROUP_ACTIONS } from './group-handlers.js';
import { homeView } from './home-view.js';
import { handleSenderManagement, SENDER_ACTIONS } from './sender-management.js';
import { composeRecipients, selectedChannels, selectedGroupIds } from './compose-groups.js';
import { GroupError } from './channel-groups.js';

const DRAFT_LIFETIME = 30 * 60 * 1000;

export function registerHandlers(app, { journal, teamId, allowedUsers = new Set(), appName = getAppName(), groups = new LocalGroups(journal.directory), access = new ChannelAccess(app.client), senders }) {
  const { composeView: renderCompose, reviewView, statusView, noticeView } = createViews(appName);
  const composeView = async (draft) => renderCompose(draft, await groups.list(teamId));
  const drafts = new Map();
  const active = new Set();
  let currentPolicy;
  const refreshPolicy = async () => { if (senders) currentPolicy = await senders.policy(teamId); };
  const permitted = (userId) => currentPolicy ? currentPolicy.allowed.has(userId) : (!allowedUsers.size || allowedUsers.has(userId));
  const prune = () => {
    for (const [id, draft] of drafts) {
      if (draft.state !== 'sending' && Date.now() - draft.createdAt > DRAFT_LIFETIME) drafts.delete(id);
    }
  };
  const findDraft = (body, view) => {
    prune();
    const draft = drafts.get(view.private_metadata);
    return draft && draft.userId === body.user.id && draft.teamId === body.team?.id && permitted(body.user.id)
      ? draft : undefined;
  };
  const logError = (logger, action, error) => logger.error(`${action}: ${error.code || error.name || 'unknown_error'}`);
  const update = async (client, logger, viewId, view, hash) => {
    try {
      await client.views.update({ view_id: viewId, view, ...(hash ? { hash } : {}) });
      return true;
    } catch (error) {
      // Closing a progress dialog never cancels a send or its receipt.
      logError(logger, 'Could not update dialog', error);
      return false;
    }
  };
  const expired = (ack) => ack({
    response_action: 'update',
    view: noticeView('This draft has expired or is unavailable. Run /broadcast to start again.'),
  });
  const groupHandler = createGroupHandler({
    groups, access, client: app.client, teamId, appName,
    stashDraft: async (payload) => {
      const draft = findDraft(payload, payload.view);
      if (!draft || draft.state !== 'compose') throw new Error('Draft unavailable');
      draft.text = payload.view.state?.values?.message?.text?.value || '';
      draft.channels = selectedChannels(payload.view.state?.values);
      draft.additionalChannels = [...draft.channels];
      draft.savedGroupIds = selectedGroupIds(payload.view.state?.values);
      return draft.id;
    },
    compose: async ({ userId, channels, draftId }) => {
      prune();
      let draft = drafts.get(draftId);
      if (draft?.userId !== userId || draft?.teamId !== teamId || draft?.state !== 'compose') draft = undefined;
      if (!draft) {
        draft = { id: randomUUID(), userId, teamId, channels: [], text: '', createdAt: Date.now(), state: 'compose' };
        drafts.set(draft.id, draft);
      }
      if (channels) Object.assign(draft, { channels: [...channels], additionalChannels: [...channels], savedGroupIds: [] });
      return composeView(draft);
    },
  });
  const groupAuthorized = (body) => !!body.user?.id && body.team?.id === teamId && permitted(body.user.id);
  const publishHome = async (userId) => {
    await refreshPolicy();
    return app.client.views.publish({ user_id: userId, view: homeView({ appName, authorized: permitted(userId), isAdmin: !!currentPolicy?.admins.has(userId), jobs: permitted(userId) ? journal.recent(teamId, userId) : [] }) });
  };
  app.event('app_home_opened', async ({ event, body }) => {
    if (body.team_id === teamId && event.tab === 'home') await publishHome(event.user);
  });
  for (const actionId of ['home_compose', 'home_groups', 'home_refresh', 'home_results']) app.action(actionId, async ({ ack, body }) => {
    await ack();
    await refreshPolicy();
    if (!groupAuthorized(body)) return;
    const action = body.actions[0];
    if (actionId === 'home_refresh') return publishHome(body.user.id);
    if (actionId === 'home_groups') return groupHandler({ command: '/broadcast', text: 'groups', team_id: teamId, user_id: body.user.id, trigger_id: body.trigger_id });
    let view;
    if (actionId === 'home_results') {
      const job = journal.get(action.value);
      view = job?.teamId === teamId && job?.userId === body.user.id ? statusView(job) : noticeView('This receipt is unavailable.');
    } else {
      const draft = { id: randomUUID(), userId: body.user.id, teamId, channels: [], text: '', createdAt: Date.now(), state: 'compose' };
      drafts.set(draft.id, draft);
      view = await composeView(draft);
    }
    await app.client.views.open({ trigger_id: body.trigger_id, view });
  });
  if (senders) {
    for (const actionId of SENDER_ACTIONS) app.action(actionId, async ({ ack, body }) => {
      await ack();
      await refreshPolicy();
      if (body.team?.id !== teamId || !currentPolicy.admins.has(body.user?.id)) return;
      await handleSenderManagement(body, { senders, teamId, client: app.client });
    });
    app.view('sender_save', async ({ ack, body }) => {
      await refreshPolicy();
      if (body.team?.id !== teamId || !currentPolicy.admins.has(body.user?.id)) return ack({ response_action: 'update', view: noticeView('Only app administrators can manage approved senders.') });
      await ack(await handleSenderManagement(body, { senders, teamId, client: app.client }));
    });
  }

  for (const actionId of GROUP_ACTIONS) app.action(actionId, async ({ ack, body }) => {
    await ack();
    await refreshPolicy();
    if (groupAuthorized(body)) await groupHandler(body);
  });
  app.view('group_save', async ({ ack, body }) => {
    await refreshPolicy();
    if (!groupAuthorized(body)) return ack({ response_action: 'update', view: noticeView('You do not have access to use this app.') });
    await ack(await groupHandler(body));
  });

  app.command('/broadcast', async ({ command, ack, client, respond, logger }) => {
    await ack();
    await refreshPolicy();
    if (command.team_id !== teamId || !permitted(command.user_id)) {
      await respond({ response_type: 'ephemeral', text: `You do not have access to use ${appName}.` });
      return;
    }
    prune();
    if (command.text.trim().toLowerCase() === 'groups') {
      try { await groupHandler(command); }
      catch (error) {
        logError(logger, 'Could not open shared groups', error);
        await respond({ response_type: 'ephemeral', text: 'Could not open shared groups. Please try /broadcast groups again.' });
      }
      return;
    }
    let view;
    if (command.text.trim().toLowerCase() === 'status') {
      const job = journal.latest(command.team_id, command.user_id);
      view = job ? statusView(job) : noticeView('You have no broadcast results yet. Run /broadcast to compose a message.');
    } else {
      if (command.text.length > MAX_MESSAGE_LENGTH) {
        await respond({ response_type: 'ephemeral', text: `Messages can contain up to ${MAX_MESSAGE_LENGTH} characters. Run /broadcast to compose a shorter message.` });
        return;
      }
      const draft = {
        id: randomUUID(), userId: command.user_id, teamId: command.team_id,
        channels: [], text: command.text, createdAt: Date.now(), state: 'compose',
      };
      drafts.set(draft.id, draft);
      view = await composeView(draft);
    }
    try {
      await client.views.open({ trigger_id: command.trigger_id, view });
    } catch (error) {
      logError(logger, 'Could not open dialog', error);
      await respond({ response_type: 'ephemeral', text: 'Could not open the broadcast dialog. Please run /broadcast again.' });
    }
  });

  app.view('broadcast_compose', async ({ ack, body, view }) => {
    await refreshPolicy();
    const draft = findDraft(body, view);
    if (!draft) return expired(ack);
    if (draft.state !== 'compose' && draft.state !== 'review') return expired(ack);
    let recipients;
    try { recipients = await composeRecipients(view.state.values, groups, teamId); }
    catch (error) {
      if (error instanceof GroupError) return ack({ response_action: 'errors', errors: { [error.field]: error.message } });
      throw error;
    }
    const { channels } = recipients;
    const text = view.state.values.message?.text?.value || '';
    const errors = {};
    if (!channels.length || channels.length > MAX_CHANNELS || channels.some((id) => !/^[CG][A-Z0-9]+$/.test(id))) {
      errors.channels = `Choose between 1 and ${MAX_CHANNELS} channels.`;
    }
    if (!text.trim() || text.length > MAX_MESSAGE_LENGTH) {
      errors.message = `Enter a message of 1 to ${MAX_MESSAGE_LENGTH} characters.`;
    }
    if (Object.keys(errors).length) return ack({ response_action: 'errors', errors });
    try { await access.assert(body.user.id, channels); }
    catch { return ack({ response_action: 'errors', errors: { channels: 'Could not verify every destination. Join private channels and invite the app, then try again.' } }); }
    Object.assign(draft, { ...recipients, text, state: 'review' });
    await ack({ response_action: 'update', view: reviewView(draft) });
  });

  app.action('broadcast_edit', async ({ ack, body, client, logger }) => {
    await ack();
    await refreshPolicy();
    const draft = findDraft(body, body.view);
    if (!draft || draft.state !== 'review') return;
    // Lock while the view changes so an overlapping Send cannot race this edit.
    draft.state = 'editing';
    const changed = await update(client, logger, body.view.id, await composeView(draft), body.view.hash);
    draft.state = changed ? 'compose' : 'review';
  });

  app.view('broadcast_send', async ({ ack, body, view, client, logger }) => {
    await refreshPolicy();
    const draft = findDraft(body, view);
    if (!draft) return expired(ack);
    if (draft.state === 'sending' || draft.state === 'done') {
      const job = journal.get(draft.id);
      await ack({ response_action: 'update', view: job ? statusView(job) : noticeView('This broadcast has already started. Use /broadcast status to check its delivery.') });
      return;
    }
    if (draft.state !== 'review') return expired(ack);
    // Set synchronously before the first await to ignore repeated Send events.
    draft.state = 'sending';
    try { await access.assert(body.user.id, draft.channels); }
    catch {
      draft.state = 'review';
      return ack({ response_action: 'update', view: noticeView('Channel access could not be verified. Run /broadcast to check your destinations again.') });
    }
    await ack({ response_action: 'update', view: noticeView('Sending your message. Use /broadcast status to check delivery if you close this dialog.') });
    const task = (async () => {
      try {
        const guardedClient = senders ? { chat: { postMessage: async (args) => {
          if (!(await senders.policy(teamId)).allowed.has(draft.userId)) throw Object.assign(new Error('Sender no longer approved'), { code: 'slack_webapi_platform_error', data: { error: 'sender_not_authorized' } });
          return client.chat.postMessage(args);
        } } } : client;
        const job = await deliver({ client: guardedClient, journal, draft });
        await update(client, logger, view.id, statusView(job));
      } catch (error) {
        logError(logger, 'Broadcast interrupted', error);
        await update(client, logger, view.id, noticeView('Sending was interrupted. Some channels may have received the message. Check the channels and /broadcast status before trying again.'));
      } finally {
        draft.state = 'done';
        // Release the composed message; the receipt contains delivery metadata only.
        draft.text = '';
      }
    })();
    active.add(task);
    try { await task; } finally { active.delete(task); }
  });

  return { drain: () => Promise.allSettled([...active]) };
}
