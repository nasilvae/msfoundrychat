import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { AzureOpenAI } from "openai";

dotenv.config();

const {
  AZURE_OPENAI_ENDPOINT,
  AZURE_OPENAI_DEPLOYMENT,
  AZURE_OPENAI_API_VERSION,
  AZURE_OPENAI_API_KEY,
  PORT = 8787,
} = process.env;

if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_API_KEY || !AZURE_OPENAI_DEPLOYMENT) {
  console.error("Missing Azure OpenAI env vars. See .env.example");
  process.exit(1);
}

const client = new AzureOpenAI({
  endpoint: AZURE_OPENAI_ENDPOINT,
  apiKey: AZURE_OPENAI_API_KEY,
  apiVersion: AZURE_OPENAI_API_VERSION,
  deployment: AZURE_OPENAI_DEPLOYMENT,
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const usageStats = {
  totalRequests: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  totalTokens: 0,
  requests: [],
};

const MAX_STORED_REQUESTS = 100;

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/usage", (_req, res) => {
  res.json({
    summary: {
      totalRequests: usageStats.totalRequests,
      totalPromptTokens: usageStats.totalPromptTokens,
      totalCompletionTokens: usageStats.totalCompletionTokens,
      totalTokens: usageStats.totalTokens,
    },
    recentRequests: usageStats.requests,
  });
});

app.post("/api/chat", async (req, res) => {
  const { messages } = req.body ?? {};
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: "messages must be an array" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const requestStart = new Date().toISOString();

  try {
    const stream = await client.chat.completions.create({
      model: AZURE_OPENAI_DEPLOYMENT,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    });

    let usage = null;
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content ?? "";
      if (delta) {
        res.write(`data: ${JSON.stringify({ delta })}\n\n`);
      }
      if (chunk.usage) {
        usage = chunk.usage;
      }
    }

    if (usage) {
      usageStats.totalRequests += 1;
      usageStats.totalPromptTokens += usage.prompt_tokens ?? 0;
      usageStats.totalCompletionTokens += usage.completion_tokens ?? 0;
      usageStats.totalTokens += usage.total_tokens ?? 0;
      usageStats.requests.unshift({
        timestamp: requestStart,
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
      });
      if (usageStats.requests.length > MAX_STORED_REQUESTS) {
        usageStats.requests.pop();
      }
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    console.error(err);
    res.write(`data: ${JSON.stringify({ error: err.message ?? "unknown" })}\n\n`);
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
