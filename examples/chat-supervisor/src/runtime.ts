import { eq } from "@super-line/core";
import { createSuperLineClient } from "@super-line/client";
import { webSocketClientTransport } from "@super-line/transport-websocket";
import { crdtCollectionsClient } from "@super-line/collections-crdt-memory";
import { chatClient } from "@super-line/plugin-chat/client";
import { chatAgentTools } from "@super-line/plugin-chat/ai-sdk";
import { createMastraRunner } from "@super-line/plugin-chat/mastra";
import { RequestContext } from "@mastra/core/request-context";
import type { auth } from "@super-line/plugin-auth/server";
import type { chat as chatKitFactory } from "@super-line/plugin-chat/server";
import type { ModelMessage, Tool } from "ai";
import { worker, makeAgents, RESOURCE_SHAPES, MODEL } from "./agents.js";
import { app } from "./contract.js";

type AuthKit = ReturnType<typeof auth<typeof app>>;
type ChatKit = ReturnType<typeof chatKitFactory<typeof app>>;

export const AGENT_CHANNEL = "agents";
const KINDS = ["canvas", "doc"] as const;
const RUNTIME_MARKER = "chat-supervisor";

async function provisionRuntimeUser(authKit: AuthKit) {
  let user = (
    await authKit.users.find({ filter: eq("displayName", "Supervisor"), includeDeactivated: true })
  ).find((candidate) => candidate.metadata?.runtime === RUNTIME_MARKER);
  if (!user) {
    user = await authKit.users.create({
      displayName: "Supervisor",
      metadata: { runtime: RUNTIME_MARKER },
    });
  }
  if (user.deletedAt != null) {
    await authKit.users.reactivate(user.id);
    user = { ...user, deletedAt: null };
  }
  for (const key of await authKit.apiKeys.listFor(user.id)) {
    if (key.label === RUNTIME_MARKER) await authKit.apiKeys.revoke(key.id);
  }
  const { key } = await authKit.apiKeys.create(user.id, { role: "user", label: RUNTIME_MARKER });
  return { user, apiKey: key };
}

export async function startSupervisor(deps: {
  authKit: AuthKit;
  chatKit: ChatKit;
  url: string;
  registerUser: (userId: string) => Promise<void>;
}): Promise<void> {
  const { authKit, chatKit, url, registerUser } = deps;
  const { user, apiKey } = await provisionRuntimeUser(authKit);
  await registerUser(user.id);
  const found = (await chatKit.channels.find({ filter: eq("name", AGENT_CHANNEL) }))[0];
  if (!found) await chatKit.channels.create({ name: AGENT_CHANNEL });

  const client = createSuperLineClient(app, {
    transport: webSocketClientTransport({ url }),
    role: "user",
    params: { apiKey },
    crdtCollections: crdtCollectionsClient(),
  });
  const automation = chatClient(client, { userId: user.id });
  await automation.ready;

  const seeded = new Set<string>();
  const ensureResources = async (channelId: string): Promise<void> => {
    if (seeded.has(channelId)) return;
    seeded.add(channelId);
    try {
      const existing = await chatKit.resources.of(channelId);
      for (const kind of KINDS) {
        if (!existing.some((resource) => resource.kind === kind)) {
          await chatKit.resources.create({
            channelId,
            kind,
            title: kind === "canvas" ? "Canvas" : "Doc",
          });
        }
      }
    } catch (error) {
      seeded.delete(channelId);
      console.error("resource seeding failed", channelId, error);
    }
  };

  const tools = chatAgentTools(client, { resourceShapes: RESOURCE_SHAPES });
  const touched = new Map<string, { kind: string; docId: string }[]>();
  const announcing = (name: "read_resource" | "write_resource"): Tool => {
    const base = tools[name]! as Tool & {
      execute: (input: unknown, options: unknown) => Promise<unknown>;
    };
    return {
      ...base,
      execute: async (input: unknown, options: unknown) => {
        const { channelId, kind, docId } = input as {
          channelId: string;
          kind: string;
          docId: string;
        };
        touched.set(channelId, [...(touched.get(channelId) ?? []), { kind, docId }]);
        void automation.announceResource(kind, docId, "open").catch(() => {});
        return base.execute(input, options);
      },
    } as Tool;
  };
  const closeTouched = (channelId: string): void => {
    for (const { kind, docId } of touched.get(channelId) ?? []) {
      void automation.announceResource(kind, docId, "close").catch(() => {});
    }
    touched.delete(channelId);
  };

  const { supervisor, editor } = makeAgents({
    read: { list_resources: tools.list_resources!, read_resource: tools.read_resource! },
    edit: {
      list_resources: tools.list_resources!,
      read_resource: announcing("read_resource"),
      write_resource: announcing("write_resource"),
    },
  });
  const runner = createMastraRunner({
    agent: supervisor,
    subagents: [{ agent: worker }, { agent: editor }],
    // 0.6.0: framing chunks reach mapDataPart before being dropped — each lane's `finish` chunk
    // carries that agent's run usage, so the supervisor AND every delegated subagent persist
    // their own token count as a durable data part in their own lane.
    mapDataPart: (chunk) => {
      if (chunk.type !== "finish") return undefined;
      const usage = (
        chunk.payload as {
          output?: { usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } };
        }
      ).output?.usage;
      // presence-based: no reported usage fields → no part; a genuine 0-token turn still gets one
      if (usage?.totalTokens === undefined && usage?.inputTokens === undefined && usage?.outputTokens === undefined)
        return undefined;
      return {
        data: {
          kind: "usage" as const,
          ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
          ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
          totalTokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        },
      };
    },
  });

  const contextMessage = async (channelId: string): Promise<ModelMessage> => {
    const resources = await chatKit.resources.of(channelId);
    const lines = resources.map(
      (resource) => `  • ${resource.kind}: docId "${resource.docId}" (title "${resource.title}")`,
    );
    return {
      role: "system",
      content:
        `You are answering in chat channel "${channelId}". ` +
        `Pass this exact channelId to every resource tool. This channel's shared resources:\n${lines.join("\n")}\n` +
        `To edit the canvas or doc, delegate to the editor with the kind + docId.`,
    };
  };

  const modelInput = async (channelId: string): Promise<ModelMessage[]> => {
    const page = await automation.history(channelId, { limit: 50 });
    const transcript = page.messages.flatMap((message): ModelMessage[] => {
      if (typeof message.content !== "string") return [];
      return [
        { role: message.authorId === user.id ? "assistant" : "user", content: message.content },
      ];
    });
    return [await contextMessage(channelId), ...transcript];
  };

  const respond = async (channelId: string): Promise<void> => {
    if (!process.env.AI_GATEWAY_API_KEY) {
      await automation.send(
        channelId,
        "Set AI_GATEWAY_API_KEY in .env to bring the supervisor online.",
      );
      return;
    }
    const input = await modelInput(channelId);
    const writer = await automation.stream(channelId, { metadata: { producer: RUNTIME_MARKER } });
    try {
      const result = await runner.run(writer, input, {
        abortSignal: writer.signal,
        // Mastra ≥1.50 requires a RequestContext INSTANCE (.get()), not a plain object
        requestContext: new RequestContext([["channelId", channelId]]),
      });
      // The settle contract (0.5 migration guide §10): a member cancel settles the row SERVER-side
      // — the producer must not finalize after it. A cancelled turn is a settled turn, not an error.
      if (writer.signal.aborted) return;
      await writer.finalize(result.error ? { status: "error", error: result.error } : {});
    } catch (error) {
      // writer.abort is idempotent after a server-side settle (a cancel already settled the row →
      // no-op), so a genuine error still surfaces instead of being swallowed by a signal check
      await writer.abort(error instanceof Error ? error.message : String(error)).catch(() => {});
      throw error;
    } finally {
      closeTouched(channelId);
    }
  };

  const feeds = new Map<string, ReturnType<typeof automation.messages>>();
  const starting = new Set<string>();
  const startChannel = async (channelId: string): Promise<void> => {
    if (feeds.has(channelId) || starting.has(channelId)) return;
    starting.add(channelId);
    try {
      await ensureResources(channelId);
      const feed = automation.messages(channelId);
      feeds.set(channelId, feed);
      const handled = new Set<string>();
      let primed = false;
      let queue: Promise<void> | undefined;
      const drain = (): void => {
        if (!primed) return;
        for (const message of feed.rows()) {
          if (handled.has(message.id) || message.status === "streaming") continue;
          handled.add(message.id);
          if (
            message.authorId === user.id ||
            typeof message.content !== "string" ||
            message.metadata?.resource
          )
            continue;
          queue = (queue ?? Promise.resolve())
            .then(() => respond(channelId))
            .catch((error) => console.error("supervisor turn failed", error));
          void queue;
        }
      };
      feed.subscribe(drain);
      await feed.ready;
      let lastOwn = -1;
      for (let index = 0; index < feed.rows().length; index++) {
        if (feed.rows()[index]?.authorId === user.id) lastOwn = index;
      }
      for (let index = 0; index <= lastOwn; index++) handled.add(feed.rows()[index]!.id);
      primed = true;
      drain();
    } finally {
      starting.delete(channelId);
    }
  };

  const directory = automation.channels();
  const startVisibleChannels = (): void => {
    for (const channel of directory.rows()) void startChannel(channel.id);
  };
  directory.subscribe(startVisibleChannels);
  await directory.ready;
  startVisibleChannels();

  console.log(
    `  🤖 Supervisor online in #${AGENT_CHANNEL} (${process.env.AI_GATEWAY_API_KEY ? MODEL : "no AI_GATEWAY_API_KEY"})`,
  );
}
