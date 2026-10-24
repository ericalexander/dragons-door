/**
 * A small MCP server over stdio: newline-delimited JSON-RPC 2.0, with just what the game uses
 * (initialize, ping, tools/list, tools/call). Written here rather than bundling the full SDK, so the
 * plugin ships a few dozen kilobytes of readable code.
 */
import { createInterface } from "node:readline";
import { objectSchema, parseArgs, type Shape } from "./z.js";

export interface ToolResult { content: { type: "text"; text: string }[]; isError?: boolean }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (args: Record<string, any>) => Promise<ToolResult> | ToolResult;
interface Tool { name: string; description: string; shape: Shape; handler: Handler; annotations?: Record<string, unknown> }

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];

export class McpServer {
  private tools = new Map<string, Tool>();
  private client: { name?: string; version?: string } | undefined;

  constructor(private info: { name: string; version: string }) {}

  /** Register a tool. Returns a handle for adding annotations afterwards. */
  tool(name: string, description: string, shape: Shape, handler: Handler) {
    const t: Tool = { name, description, shape, handler };
    this.tools.set(name, t);
    return { update: (u: { annotations: Record<string, unknown> }) => { t.annotations = u.annotations; } };
  }

  /** The app that connected (Claude Code and its version), once it has said hello. */
  clientVersion() { return this.client; }

  /** Serve on stdin/stdout until stdin closes. */
  async connect(): Promise<void> {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on("line", (line) => { if (line.trim()) void this.handle(line); });
    await new Promise<void>((resolve) => rl.on("close", resolve));
  }

  private send(msg: unknown) { process.stdout.write(JSON.stringify(msg) + "\n"); }

  private async handle(line: string) {
    let msg: { id?: string | number | null; method?: string; params?: Record<string, unknown> };
    try { msg = JSON.parse(line); } catch { this.send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
    if (!msg.method) return; // a response to something we never ask
    const isRequest = msg.id !== undefined && msg.id !== null;
    try {
      const result = await this.dispatch(msg.method, msg.params ?? {});
      if (isRequest) this.send({ jsonrpc: "2.0", id: msg.id, result });
    } catch (e) {
      const err = e as { code?: number; message?: string };
      if (isRequest) this.send({ jsonrpc: "2.0", id: msg.id, error: { code: err.code ?? -32603, message: err.message ?? "Internal error" } });
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const asked = String(params.protocolVersion ?? "");
        this.client = params.clientInfo as { name?: string; version?: string } | undefined;
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: this.info,
        };
      }
      case "ping": return {};
      case "notifications/initialized":
      case "notifications/cancelled":
        return undefined;
      case "tools/list":
        return { tools: [...this.tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: objectSchema(t.shape), ...(t.annotations ? { annotations: t.annotations } : {}) })) };
      case "tools/call": {
        const t = this.tools.get(String(params.name));
        if (!t) throw { code: -32602, message: `Unknown tool: ${String(params.name)}` };
        const args = parseArgs(t.shape, params.arguments);
        if (!args.ok) return { content: [{ type: "text", text: `Invalid arguments for ${t.name}: ${args.error}` }], isError: true };
        try { return await t.handler(args.value); }
        catch (e) { return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true }; }
      }
      default:
        throw { code: -32601, message: `Method not found: ${method}` };
    }
  }
}
