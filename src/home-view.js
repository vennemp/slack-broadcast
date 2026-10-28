const plain = (text) => ({ type: 'plain_text', text });
const button = (id, text, value = 'none', primary = false) => ({ type: 'button', action_id: id, text: plain(text), value, ...(primary ? { style: 'primary' } : {}) });

export function homeView({ appName, authorized, isAdmin = false, jobs = [] }) {
  return {
    type: 'home', callback_id: 'communications_home',
    blocks: [
      { type: 'header', text: plain(appName) },
      { type: 'section', text: plain('Send one message to several channels. Choose saved groups or individual channels in Compose message, then review and send from a private dialog.') },
      { type: 'section', text: { type: 'mrkdwn', text: ':warning: *You must be a member of every private channel you send to — including private channels inside existing shared channel groups.* If you are not in one of them, Review lists it as skipped and that channel does not receive the message; everything else still sends. Public channels only need the app invited; you do not have to join them.' } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Before sending, avoid `@here`, `@channel`, `@everyone`, and similar mass mentions in broadcast messages.' }] },
      ...(authorized ? [
        { type: 'actions', elements: [button('home_compose', 'Compose message', 'none', true), button('home_groups', 'Shared channel groups'), ...(isAdmin ? [button('home_senders', 'Approved senders')] : []), button('home_refresh', 'Refresh')] },
        { type: 'divider' },
        { type: 'header', text: plain('Your recent broadcasts') },
        ...jobs.map((job) => {
          const delivered = job.results.filter((result) => result.status === 'sent').length;
          const failures = job.results.filter((result) => result.status === 'failed').length;
          const unconfirmed = job.results.filter((result) => result.status === 'unknown').length;
          const date = new Date(job.createdAt).toISOString().replace('T', ' ').slice(0, 16);
          return {
            type: 'section', text: plain(`${date} UTC\n${delivered}/${job.results.length} delivered${failures ? ` · ${failures} failed` : ''}${unconfirmed ? ` · ${unconfirmed} unconfirmed` : ''}${job.finishedAt ? '' : ' · In progress'}`),
            accessory: button('home_results', 'View results', job.id),
          };
        }),
        ...(!jobs.length ? [{ type: 'section', text: plain('No broadcasts yet. Compose your first message to get started.') }] : []),
      ] : [
        { type: 'section', text: plain('Sending and shared-group management are limited to designated communications staff. Contact your workspace administrator if you need access.') },
        ...(isAdmin ? [{ type: 'actions', elements: [button('home_senders', 'Approved senders')] }, { type: 'context', elements: [plain('You are an app administrator. Approve yourself for sending if you also need to compose broadcasts.')] }] : []),
      ]),
      { type: 'divider' },
      { type: 'header', text: plain('Adding private and customer channels') },
      { type: 'section', text: plain('To use a private channel, a member of that channel must add the app to it first. You must also belong to the channel. For customer or other external channels, we recommend asking the external participants for permission before adding the app.') },
      { type: 'section', text: plain('Copy and paste this permission request into the channel:') },
      { type: 'section', text: { type: 'mrkdwn', text: `\`\`\`Hi everyone! Would you be comfortable with us adding ${appName}, our Slack message broadcast app, to this channel? We use it to share updates, such as planned maintenance, requirements, and other important announcements.\n\nThe app backend is hosted on Google Cloud Run. It can post messages and read basic channel information to check access, but it cannot read channel message history. Only approved senders can post updates. For private channels, the sender must already be a member.\n\nThis helps us share updates without manually copying and pasting messages.\`\`\`` } },
      { type: 'divider' },
      { type: 'header', text: plain('About this app') },
      { type: 'section', text: plain('The backend is hosted on Google Cloud Run.') },
      { type: 'section', text: { type: 'mrkdwn', text: 'Source code and issues: <https://github.com/vennemp/slack-broadcast|github.com/vennemp/slack-broadcast>' } },
      { type: 'section', text: plain('Permissions: post as this app and read basic channel information to check access. Channel message history is not read. The app must be invited to destination channels; senders must belong to private destinations.') },
      { type: 'section', text: plain('Storage: approved sender IDs, access change records, shared channel groups, and delivery records are saved. Draft and pending message text is stored temporarily and cleared when delivery processing finishes. Cloud drafts expire after 30 minutes; draft records become eligible for deletion after one day and delivery records after 30 days. Shared groups and access configuration remain until changed or removed. Slack keeps posted messages under its own retention policy.') },
      { type: 'context', elements: [plain('You can also use /broadcast, /broadcast groups, and /broadcast status. No channel message is posted until you confirm Send.')] },
    ],
  };
}
