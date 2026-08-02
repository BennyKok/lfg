import { defaultModelForAgent, modelsForAgent } from "./agent-catalog.ts";
import type { ResumableBackend } from "./resume-cache.ts";

export function resolveResumeModel(
  backend: ResumableBackend,
  storedModel?: string | null,
  requestedModel?: string | null,
): string {
  const allowed = modelsForAgent(backend);
  if (storedModel && allowed.includes(storedModel)) return storedModel;
  if (requestedModel && allowed.includes(requestedModel)) return requestedModel;
  return defaultModelForAgent(backend);
}
