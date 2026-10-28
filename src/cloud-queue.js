export function createQueue({ client, projectId, region, queueId, serviceUrl, serviceAccount }) {
  const parent = client.queuePath(projectId, region, queueId);
  return {
    async enqueue(id) {
      try {
        await client.createTask({
          parent,
          task: {
            name: `${parent}/tasks/broadcast-${id}`,
            dispatchDeadline: { seconds: 300 },
            // Let Slack display the progress view before the worker can finish.
            scheduleTime: { seconds: Math.floor(Date.now() / 1000) + 5 },
            httpRequest: {
              httpMethod: 'POST', url: `${serviceUrl}/tasks/deliver`,
              headers: { 'Content-Type': 'application/json' },
              body: Buffer.from(JSON.stringify({ id })).toString('base64'),
              oidcToken: { serviceAccountEmail: serviceAccount, audience: serviceUrl },
            },
          },
        }, { timeout: 1500, retry: null });
      } catch (error) {
        // A lost create response or repeated Send uses the same named task.
        if (error.code !== 6) throw error;
      }
    },
  };
}
