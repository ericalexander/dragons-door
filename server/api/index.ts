// Vercel entry point. vercel.json rewrites every path here; Hono sees the original URL.
import { handle } from "hono/vercel";
import { app } from "../src/app.js";

export default handle(app);
