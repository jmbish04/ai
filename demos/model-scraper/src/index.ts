import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";

/**
 * Environment Bindings
 */
interface Env {
  GITHUB_TOKEN: string;
  OPENAI_API_KEY: string;
  JSON_DATA: KVNamespace;
}

const app = new Hono<{ Bindings: Env }>();

// Standard Middleware
app.use("*", cors());

/**
 * Default Analysis Prompt
 * Grounded in 2026 Cloudflare Developer Ecosystem patterns
 */
const DEFAULT_SYSTEM_PROMPT = `You are a Codex Senior Engineer specializing in the Cloudflare Ecosystem. 
Analyze the provided GitHub repository structure and configuration files to provide a deep technical breakdown.

Required Breakdown Areas:
1. Cloudflare Stack: Identify usage of Workers, Pages, and Bindings (D1, KV, R2, Vectorize, Hyperdrive, AI Gateway).
2. Infrastructure: Identify patterns in wrangler.jsonc/toml, deployment scripts, and monorepo orchestration (Nx/Turbo).
3. Frontend Capabilities: Detailed breakdown of Astro, React, Vite (@cloudflare/vite-plugin), Tailwind CSS, and Shadcn UI (Dark Theme).
4. Standards Check: Verify use of Biome/Oxlint, Zod validation, and mandatory endpoints (/health, /context, /docs).
5. Agentic Patterns: Search for Agents SDK, Workflows, Durable Objects, or RPC methods.

Format the response as a professional architectural review.`;

/**
 * POST /analyze
 * Triggers a deep analysis of a public GitHub repository.
 */
app.post("/analyze", async (c) => {
  try {
    const body = await c.req.json();
    const { repoUrl, prompt: userPrompt } = z.object({
      repoUrl: z.string().url(),
      prompt: z.string().optional()
    }).parse(body);

    const { owner, repo } = parseGitHubUrl(repoUrl);
    
    // 1. Fetch Repository Metadata (Recursive Tree)
    const fileTree = await fetchGitHubTree(owner, repo, c.env.GITHUB_TOKEN);
    const criticalTargets = [
      "package.json", 
      "wrangler.jsonc", 
      "wrangler.toml", 
      "nx.json", 
      "biome.json", 
      "astro.config.ts", 
      "vite.config.ts",
      "AGENTS.md"
    ];
    
    // 2. Extract content from critical configuration files
    const fileContents = await fetchCriticalFiles(owner, repo, fileTree, criticalTargets, c.env.GITHUB_TOKEN);

    // 3. Setup AI Client
    const openai = createOpenAI({
      apiKey: c.env.OPENAI_API_KEY,
    });
    const model = openai("gpt-4o");

    // 4. Construct instruction with optional highlight area
    const instructions = userPrompt 
      ? `${DEFAULT_SYSTEM_PROMPT}\n\nSPECIAL AREA TO HIGHLIGHT: ${userPrompt}`
      : DEFAULT_SYSTEM_PROMPT;

    // 5. Generate Analysis
    const { text } = await generateText({
      model,
      system: instructions,
      prompt: `Analyze this repository data:\n\nFile List:\n${JSON.stringify(fileTree, null, 2)}\n\nConfig Files:\n${JSON.stringify(fileContents, null, 2)}`,
    });

    return c.json({ 
      analysis: text,
      repo: { owner, repo },
      filesAnalyzed: Object.keys(fileContents)
    });

  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

/**
 * Standard Infrastructure Endpoints
 */
app.get("/health", (c) => c.json({ status: "healthy", timestamp: new Date().toISOString() }));

app.get("/context", (c) => c.json({ 
  stack: "Hono, AI SDK, OpenAI",
  purpose: "Architectural Learning & AGENTS.md Standardisation"
}));

/**
 * GitHub API Utilities
 */
function parseGitHubUrl(url: string) {
  const cleanUrl = url.endsWith("/") ? url.slice(0, -1) : url;
  const parts = cleanUrl.replace("https://github.com/", "").split("/");
  return { owner: parts[0], repo: parts[1] };
}

async function fetchGitHubTree(owner: string, repo: string, token: string) {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/main?recursive=1`;
  const response = await fetch(url, {
    headers: { 
      Authorization: `Bearer ${token}`, 
      "User-Agent": "cloudflare-repo-analyzer" 
    }
  });
  if (!response.ok) return [];
  const data: any = await response.json();
  return data.tree?.map((f: any) => f.path) || [];
}

async function fetchCriticalFiles(owner: string, repo: string, tree: string[], targets: string[], token: string) {
  const contents: Record<string, string> = {};
  // Limit to top 10 most relevant files to manage token context
  const foundPaths = tree.filter(path => targets.some(t => path.endsWith(t))).slice(0, 10);

  for (const path of foundPaths) {
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/${path}`;
    const resp = await fetch(rawUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (resp.ok) {
      contents[path] = await resp.text();
    }
  }
  return contents;
}

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
