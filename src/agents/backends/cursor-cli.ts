import { resolveModelForAgent } from "../../agent-catalog.ts";
import { cursorBin } from "../../tmux.ts";

export async function pipeToCursorCli(
  prompt: string,
  log: (s: string) => void,
  opts: {
    model?: string;
    thinkingLevel?: string;
    cwd?: string;
    /** When true, allow writes/shell (default is plan/read-only). */
    writable?: boolean;
  } = {},
): Promise<string> {
  const cwd = opts.cwd ?? process.cwd();
  const model =
    resolveModelForAgent("cursor", opts.model ?? "auto", opts.thinkingLevel) ??
    opts.model ??
    "auto";
  const argv = [
    cursorBin(),
    "-p",
    "--trust",
    "--output-format",
    "text",
    "--workspace",
    cwd,
  ];
  if (opts.writable) {
    argv.push("--yolo", "--sandbox", "disabled");
  } else {
    argv.push("--mode", "plan");
  }
  if (model && model !== "auto") argv.push("--model", model);
  argv.push(prompt);

  log(`[runner] piping ${prompt.length} chars to cursor-agent -p (${model})`);
  const proc = Bun.spawn({
    cmd: argv,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `cursor-agent -p exited ${code}: ${err.slice(0, 1000) || out.slice(0, 1000)}`,
    );
  }
  if (err.trim()) log(`[runner] cursor stderr: ${err.slice(0, 400)}`);
  const text = out.trim();
  if (!text) throw new Error("cursor-agent -p produced empty output");
  log(`[runner] cursor done (${text.length} chars)`);
  return text;
}
