// Vercel's Hono preset imports this file and expects the app as the default export.
// Local development uses src/dev.ts, which wraps it in a Node server.
import { app } from "./app.js";
export { app };
export default app;
