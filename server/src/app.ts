import { Hono } from "hono";
import { api } from "./api.js";

export const app = new Hono();
app.get("/", (c) => c.json({ realm: "Dragonmoor", ok: true }));
app.route("/v1", api);

export default app;
