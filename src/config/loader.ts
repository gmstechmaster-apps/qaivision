import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.resolve(__dirname, "../../config");

export interface ModelsConfig {
  ollama: { host: string; requestTimeoutMs: number };
  planner: { model: string; temperature: number };
  vision: { model: string; temperature: number };
}

export interface ModelOverrides {
  plannerModel?: string;
  visionModel?: string;
  ollamaHost?: string;
}

async function loadYaml<T>(file: string): Promise<T> {
  const raw = await readFile(path.join(CONFIG_DIR, file), "utf-8");
  return yaml.load(raw) as T;
}

/**
 * Model selection is resolved fresh on every call from (in priority order):
 * CLI flag > env var > config/models.yaml. This is what lets the vision
 * (or planner) model be swapped at any time without touching code.
 */
export async function loadModelsConfig(overrides: ModelOverrides = {}): Promise<ModelsConfig> {
  const base = await loadYaml<ModelsConfig>("models.yaml");
  return {
    ollama: {
      host: overrides.ollamaHost ?? process.env.AIQA_OLLAMA_HOST ?? base.ollama.host,
      requestTimeoutMs: base.ollama.requestTimeoutMs,
    },
    planner: {
      ...base.planner,
      model: overrides.plannerModel ?? process.env.AIQA_PLANNER_MODEL ?? base.planner.model,
    },
    vision: {
      ...base.vision,
      model: overrides.visionModel ?? process.env.AIQA_VISION_MODEL ?? base.vision.model,
    },
  };
}

interface SitesConfig {
  sites: Record<string, Record<string, { baseUrl: string; loginPath?: string }>>;
}

interface ProductsConfig {
  products: Record<string, Record<string, { product: string }>>;
}

interface CredentialsConfig {
  credentials: Record<string, Record<string, { username: string; password: string }>>;
}

export async function resolveSite(env: string, site: string): Promise<{ baseUrl: string; loginPath: string }> {
  const cfg = await loadYaml<SitesConfig>("sites.yaml");
  const entry = cfg.sites?.[env]?.[site];
  if (!entry) {
    throw new Error(`No site config for env="${env}" site="${site}" in config/sites.yaml`);
  }
  return { baseUrl: entry.baseUrl, loginPath: entry.loginPath ?? "/login" };
}

export async function resolveProduct(env: string, site: string): Promise<string> {
  const cfg = await loadYaml<ProductsConfig>("products.yaml");
  const entry = cfg.products?.[env]?.[site];
  if (!entry) {
    throw new Error(`No product config for env="${env}" site="${site}" in config/products.yaml`);
  }
  return entry.product;
}

export async function resolveCredentials(
  env: string,
  site: string,
): Promise<{ username: string; password: string }> {
  const cfg = await loadYaml<CredentialsConfig>("credentials.yaml");
  const entry = cfg.credentials?.[env]?.[site];
  if (!entry) {
    throw new Error(`No credentials for env="${env}" site="${site}" in config/credentials.yaml`);
  }
  return entry;
}

export async function listSitesForEnv(env: string): Promise<string[]> {
  const cfg = await loadYaml<SitesConfig>("sites.yaml");
  return Object.keys(cfg.sites?.[env] ?? {});
}
