import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { swaggerUI } from "@hono/swagger-ui";
import { apiReference } from "@scalar/hono-api-reference";
import { z } from "zod";

/**
 * Environment Bindings
 */
interface Env {
  GITHUB_TOKEN: string;
  OPENAI_API_KEY: string;
  AI_GATEWAY_ID: string; // The ID of your Cloudflare AI Gateway
  JSON_DATA: KVNamespace;
  AI: any; // AI Gateway Universal Run binding
}

const app = new Hono<{ Bindings: Env }>();

// Standard Middleware
app.use("*", cors());

/**
 * Default Analysis Prompt
 */
const DEFAULT_SYSTEM_PROMPT = `You are a Codex Senior Engineer specializing in the Cloudflare Ecosystem. 
Analyze the provided GitHub repository structure and configuration files to provide a technical breakdown.

Focus Areas:
1. Cloudflare Stack: Identify use of Workers, Pages, and Bindings (D1, KV, R2, Vectorize, AI Gateway).
2. Infrastructure: Check for wrangler.jsonc/toml patterns, pnpm/Nx monorepo usage, and deployment scripts.
3. Frontend Architecture: Breakdown integration of Astro, React, Vite (@cloudflare/vite-plugin), and Tailwind CSS.
4. Tooling & Standards: Evaluate Biome/Oxlint usage, Shadcn UI registry compatibility (Dark Theme), and Zod validation.
5. Agentic Patterns: Search for Agents SDK, Workflows, Durable Objects, or RPC-based "callable" methods.

Standard Recommendation: Check if they include mandatory endpoints (/health, /context, /docs) and standard OpenAPI v3.1.0 specs.`;

/**
 * POST /analyze
 * Deep analysis of a GitHub repository for Cloudflare-specific patterns.
 */
app.post("/analyze", async (c) => {
  const body = await c.req.json();
  const { repoUrl, prompt: userPrompt } = z.object({
    repoUrl: z.string().url(),
    prompt: z.string().optional()
  }).parse(body);

  const { owner, repo } = parseGitHubUrl(repoUrl);
  
  // 1. Fetch Repository Context
  const fileTree = await fetchGitHubTree(owner, repo, c.env.GITHUB_TOKEN);
  const criticalFiles = ["package.json", "wrangler.jsonc", "wrangler.toml", "nx.json", "biome.json", "astro.config.ts", "vite.config.ts"];
  const fileContents = await fetchCriticalFiles(owner, repo, fileTree, criticalFiles, c.env.GITHUB_TOKEN);

  // 2. Setup AI via Cloudflare AI Gateway
  const openai = createOpenAI({
    apiKey: c.env.OPENAI_API_KEY,
    baseURL: `https://gateway.ai.cloudflare.com/v1/${c.env.AI_GATEWAY_ID}/openai`,
  });

  const model = openai("gpt-4o"); // High-reasoning model for structural analysis

  // 3. Generate Analysis
  const finalPrompt = userPrompt 
    ? `${DEFAULT_SYSTEM_PROMPT}\n\nSPECIAL FOCUS AREA: ${userPrompt}`
    : DEFAULT_SYSTEM_PROMPT;

  const { text } = await generateText({
    model,
    system: finalPrompt,
    prompt: `Repository Structure:\n${JSON.stringify(fileTree, null, 2)}\n\nCritical File Contents:\n${JSON.stringify(fileContents, null, 2)}`,
  });

  return c.json({ 
    analysis: text,
    repo: { owner, repo },
    filesAnalyzed: Object.keys(fileContents)
  });
});

/**
 * Standard Infrastructure Endpoints
 */
app.get("/health", (c) => c.json({ status: "healthy", timestamp: new Date().toISOString() }));

app.get("/context", (c) => c.json({ 
  stack: "Hono, AI SDK, Cloudflare AI Gateway",
  purpose: "GitHub Repository Analyzer for Cloudflare standards"
}));

app.get("/openapi.json", (c) => {
  return c.json({
    openapi: "3.1.0",
    info: { title: "Repo Scraper API", version: "1.0.0" },
    paths: {
      "/analyze": {
        post: {
          summary: "Analyze a GitHub repo for CF patterns",
          requestBody: {
            content: { "application/json": { schema: { type: "object", properties: { repoUrl: { type: "string" }, prompt: { type: "string" } } } } }
          },
          responses: { "200": { description: "Technical breakdown" } }
        }
      }
    }
  });
});

app.get("/swagger", swaggerUI({ url: "/openapi.json" }));
app.get("/scalar", apiReference({ spec: { url: "/openapi.json" } }));
app.get("/docs", (c) => c.redirect("/scalar"));

/**
 * GitHub Utilities
 */
function parseGitHubUrl(url: string) {
  const parts = url.replace("https://github.com/", "").split("/");
  return { owner: parts[0], repo: parts[1] };
}

async function fetchGitHubTree(owner: string, repo: string, token: string) {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/main?recursive=1`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "cf-repo-scraper" }
  });
  if (!response.ok) return [];
  const data: any = await response.json();
  return data.tree?.map((f: any) => f.path) || [];
}

async function fetchCriticalFiles(owner: string, repo: string, tree: string[], targets: string[], token: string) {
  const contents: Record<string, string> = {};
  const foundTargets = tree.filter(path => targets.some(t => path.endsWith(t))).slice(0, 10);

  for (const path of foundTargets) {
    const resp = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/main/${path}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (resp.ok) contents[path] = await resp.text();
  }
  return contents;
}

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
