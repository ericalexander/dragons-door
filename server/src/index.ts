import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { api } from "./api.js";

const app = new Hono();
app.get("/", (c) => c.json({ realm: "Dragonmoor", ok: true }));
app.route("/v1", api);

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`Dragonmoor listening on :${port}`));
