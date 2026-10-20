import { Hono } from "hono";
import { api } from "./api.js";
import { bots } from "./bots.js";

export const app = new Hono();
app.get("/", (c) => c.json({ realm: "Dragon's Door", ok: true }));
app.route("/v1", api);
app.route("/v1/internal", bots);

export default app;
