import { PATHS } from "../config.ts";
import { addManaged, listManaged } from "../managed.ts";

const action = process.argv[2];
const dataDir = process.argv[3];

if (!action || !dataDir) {
  console.error("usage: managed-registry-process <write|read> <data-dir>");
  process.exit(2);
}

PATHS.data = dataDir;

if (action === "write") {
  addManaged({
    tmuxName: "lfg-cross-process",
    cwd: "/tmp/recovery-project",
    createdAt: 123,
    agent: "codex-aisdk",
    sessionId: "11111111-1111-4111-8111-111111111111",
    nativeSessionId: "22222222-2222-4222-8222-222222222222",
    launchState: "running",
    title: "Survives a real process restart",
  });
}

console.log(JSON.stringify(listManaged()));
