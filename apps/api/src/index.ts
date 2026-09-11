import { app } from './server/hono';

export default {
  fetch: app.fetch,
};

export type AppType = typeof app;
