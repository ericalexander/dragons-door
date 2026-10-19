#!/usr/bin/env node
/**
 * Dragonmoor MCP server. Each tool is a thin call to the realm API; all rules live on the server.
 * The narrator skill turns the returned events into prose. This file never decides outcomes.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, saveConfig } from "./config.js";

const server = new McpServer({ name: "dragonmoor", version: "0.1.0" });

async function call(method: "GET" | "POST", path: string, body?: unknown) {
  const cfg = await loadConfig();
  if (!cfg.api_key && path !== "/v1/register") {
    return { error: "not_registered", message: "No character yet. Call `register` with a name and class (warrior, thief, mage)." };
  }
  const res = await fetch(cfg.api_url + path, {
    method,
    headers: { "content-type": "application/json", ...(cfg.api_key ? { authorization: `Bearer ${cfg.api_key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ error: "bad_response", status: res.status }));
  return json;
}

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });

server.tool("register", "Create your character. Run once. Returns and stores your API key locally.",
  { name: z.string().min(2).max(20), class: z.enum(["warrior", "thief", "mage"]) },
  async ({ name, class: cls }) => {
    const cfg = await loadConfig();
    if (cfg.api_key) return text({ error: "already_registered", name: cfg.name, message: "You already have a character on this machine." });
    const r = (await call("POST", "/v1/register", { name, class: cls })) as { api_key?: string; name?: string; error?: string };
    if (r.api_key) {
      await saveConfig({ ...cfg, api_key: r.api_key, name: r.name });
      delete (r as { api_key?: string }).api_key; // never echo the key into the conversation
    }
    return text(r);
  });

server.tool("status", "Your character's current state and what you can do next.", {}, async () => text(await call("GET", "/v1/status")));

server.tool("news", "The realm's daily news: who killed whom, who leveled, who slew the dragon.",
  { day: z.enum(["today", "yesterday"]).default("today") },
  async ({ day }) => text(await call("GET", `/v1/news?day=${day}`)));

server.tool("rankings", "Top 20 players by level and experience.", {}, async () => text(await call("GET", "/v1/rankings")));

server.tool("forest", "Go into the forest looking for a fight. Uses one forest fight. Starts an encounter.", {}, async () => text(await call("POST", "/v1/forest")));

server.tool("fight", "Take one round in your current fight. attack: normal swing. special: class skill (limited per day). run: try to flee.",
  { action: z.enum(["attack", "special", "run"]) },
  async ({ action }) => text(await call("POST", "/v1/fight", { action })));

server.tool("train", "Challenge your master to advance a level. Only when you have enough experience.", {}, async () => text(await call("POST", "/v1/train")));

server.tool("dragon", "Seek the Red Dragon. Level 12 only. Uses a forest fight.", {}, async () => text(await call("POST", "/v1/dragon")));

server.tool("healer", "Pay the healer to restore hit points. Cost scales with level.",
  { hp: z.union([z.literal("all"), z.number().int().positive()]).default("all") },
  async ({ hp }) => text(await call("POST", "/v1/healer", { hp })));

server.tool("shop", "See the weapon or armor catalog.",
  { kind: z.enum(["weapon", "armor"]) },
  async ({ kind }) => text(await call("GET", `/v1/shop?kind=${kind}`)));

server.tool("buy", "Buy a weapon or armor by id. Your current one is traded in at half price.",
  { kind: z.enum(["weapon", "armor"]), id: z.number().int() },
  async ({ kind, id }) => text(await call("POST", "/v1/buy", { kind, id })));

server.tool("bank", "Deposit or withdraw gold. Gold on hand is lost when you die; banked gold is safe. Limited transactions per day.",
  { op: z.enum(["deposit", "withdraw"]), amount: z.union([z.literal("all"), z.number().int().positive()]) },
  async ({ op, amount }) => text(await call("POST", "/v1/bank", { op, amount })));

server.tool("inn", "Sleep at the inn tonight. Costs gold. Protects you from other players until the realm resets and heals you fully.", {}, async () => text(await call("POST", "/v1/inn")));

server.tool("tavern", "Visit the tavern: read what other players posted today and hear the bartender's gossip.", {}, async () => text(await call("GET", "/v1/tavern")));

server.tool("tavern_post", "Leave a message on the tavern board for everyone to see. 280 characters max.",
  { body: z.string().min(1).max(280) },
  async ({ body }) => text(await call("POST", "/v1/tavern", { body })));

server.tool("flirt", "Flirt with Violet the barmaid. Once per day. Builds charm.", {}, async () => text(await call("POST", "/v1/flirt")));

server.tool("challenge", "Attack another player in the fields. Resolves the whole fight at once. Uses one player fight.",
  { name: z.string().min(1) },
  async ({ name }) => text(await call("POST", "/v1/challenge", { name })));

const transport = new StdioServerTransport();
await server.connect(transport);
