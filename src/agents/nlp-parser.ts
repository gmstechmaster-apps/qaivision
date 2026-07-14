import { readFile } from "node:fs/promises";

export interface NlpStep {
  /** Raw natural-language instruction, verbatim from the file. */
  text: string;
  /** Present when this step is a "Verify:" block — the bullet checks to validate. */
  verifications?: string[];
}

export interface NlpScenario {
  environment: string;
  site: string;
  scenario: string;
  steps: NlpStep[];
  sourceFile: string;
}

/**
 * Parses an .nlp file into a structured but still-natural-language scenario.
 * This performs no interpretation of business meaning — that is the Planner
 * Agent's job at runtime. The parser only recognizes the file's shape:
 * `key: value` front matter, plain instruction lines, and `Verify:` blocks
 * followed by `- bullet` checks.
 */
export function parseNlp(source: string, sourceFile: string): NlpScenario {
  const lines = source.split("\n").map((l) => l.trimEnd());

  const meta: Record<string, string> = {};
  const steps: NlpStep[] = [];

  let i = 0;
  // Front matter: consecutive "key: value" lines at the top of the file.
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === "") {
      i++;
      continue;
    }
    const match = /^([a-zA-Z_]+):\s*(.+)$/.exec(line);
    if (!match) break;
    meta[match[1].toLowerCase()] = match[2].trim();
    i++;
  }

  for (const required of ["environment", "site", "scenario"]) {
    if (!meta[required]) {
      throw new Error(`${sourceFile}: missing required front-matter field "${required}"`);
    }
  }

  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;

    if (/^verify:?$/i.test(line)) {
      const verifications: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s+.+/.test(lines[j])) {
        verifications.push(lines[j].trim().replace(/^-\s*/, ""));
        j++;
      }
      steps.push({ text: "Verify", verifications });
      i = j - 1;
      continue;
    }

    steps.push({ text: line });
  }

  return {
    environment: meta.environment,
    site: meta.site,
    scenario: meta.scenario,
    steps,
    sourceFile,
  };
}

export async function loadNlpScenario(filePath: string): Promise<NlpScenario> {
  const source = await readFile(filePath, "utf-8");
  return parseNlp(source, filePath);
}
