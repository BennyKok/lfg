import { claudeEffortFor, grokBin } from "../../tmux.ts";

export async function pipeToGrokCli(
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
  const model = opts.model ?? "grok-4.5";
  const argv = [
    grokBin(),
    "--cwd",
    cwd,
    "--output-format",
    "plain",
    "--permission-mode",
    opts.writable ? "bypassPermissions" : "plan",
    "--model",
    model,
    "--verbatim",
  ];
  if (opts.writable) argv.push("--always-approve");
  const effort = claudeEffortFor(opts.thinkingLevel);
  if (effort) argv.push("--effort", effort);
  argv.push("-p", prompt);

  log(`[runner] piping ${prompt.length} chars to grok -p (${model})`);
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
    throw new Error(`grok -p exited ${code}: ${err.slice(0, 1000) || out.slice(0, 1000)}`);
  }
  if (err.trim()) log(`[runner] grok stderr: ${err.slice(0, 400)}`);
  const text = out.trim();
  if (!text) throw new Error("grok -p produced empty output");
  log(`[runner] grok done (${text.length} chars)`);
  return text;
}
