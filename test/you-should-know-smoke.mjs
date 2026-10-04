// Offline end-to-end terminal smoke. Uses only a synthetic provider and an
// isolated agent directory: no operator settings, credentials or network calls.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repo = resolve(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "ysk-smoke-"));
const provider = join(dir, "provider.ts");
writeFileSync(provider, `
import { createAssistantMessageEventStream } from ${JSON.stringify(join(repo, "node_modules/@earendil-works/pi-ai/dist/index.js"))};
export default function(pi) {
 pi.registerProvider('ysk-smoke', {
  baseUrl: 'http://127.0.0.1:9', apiKey: 'synthetic', api: 'openai-completions',
  models: [{ id: 'fixture', name: 'Offline fixture', reasoning: false, input: ['text'],
   cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096 }],
  streamSimple: (_model, context) => {
   const s = createAssistantMessageEventStream();
   const isScan = JSON.stringify(context.messages).includes('assistant_output');
   const text = isScan ? JSON.stringify({ notes: [{ kind: 'caveat', text: 'Production-data verification is still missing.', quote: 'The migration was not tested against production data.' }] }) : 'Updated all files. The migration was not tested against production data. Ready for review.';
   const message = { role: 'assistant', content: [{type:'text',text}], api:'openai-completions', provider:'ysk-smoke', model:'fixture', timestamp:Date.now(), stopReason:'stop', usage:{input:10,output:5,totalTokens:15,cacheRead:0,cacheWrite:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}} };
   queueMicrotask(() => { s.push({type:'start',partial:message}); s.push({type:'text_start',contentIndex:0,partial:message}); s.push({type:'text_delta',contentIndex:0,delta:text,partial:message}); s.push({type:'text_end',contentIndex:0,content:text,partial:message}); s.push({type:'done',reason:'stop',message}); s.end(); });
   return s;
  }
 });
}
`);
// Python's PTY drives the real interactive pi, not a fake ExtensionContext.
const script = `
import os, pty, subprocess, select, time, re, struct, fcntl, termios, json
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 100, 0, 0))
env = dict(os.environ, PI_CODING_AGENT_DIR=${JSON.stringify(dir)}, PI_SKIP_VERSION_CHECK='1', PI_OFFLINE='1', PI_TELEMETRY='0', PI_YOU_SHOULD_KNOW='0', PI_AGENDA_WORKER='0', TERM='xterm-256color')
proc = subprocess.Popen(['node', ${JSON.stringify(join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"))}, '--no-extensions', '-e', ${JSON.stringify(provider)}, '-e', ${JSON.stringify(join(repo, "extensions/you-should-know/index.ts"))}, '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-tools', '--no-session', '--provider', 'ysk-smoke', '--model', 'fixture'], stdin=slave, stdout=slave, stderr=slave, cwd=${JSON.stringify(dir)}, env=env)
os.close(slave)
raw = b''
def read_for(seconds):
 global raw
 end = time.monotonic() + seconds
 while time.monotonic() < end:
  if select.select([master], [], [], .1)[0]:
   try: raw += os.read(master, 65536)
   except OSError: break
read_for(2)
for command in ['/you-should-know on', 'Run the fixture.', '/you-should-know show', '/you-should-know dismiss', '/you-should-know off']:
 os.write(master, command.encode() + b'\\r')
 read_for(2)
text = re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]', '', raw.decode(errors='replace'))
text = re.sub(r'\\x1b\\][^\\x07]*(?:\\x07|\\x1b\\\\)', '', text)
checks = { 'enabled': 'You should know enabled.' in text, 'widget': '[caveat] Production-data verification is still missing.' in text, 'quote': 'Source: The migration was not tested against production data.' in text, 'dismissed': 'Notes dismissed.' in text, 'disabled': 'You should know disabled.' in text }
print(json.dumps(checks, indent=2))
if not all(checks.values()): print(text)
os.write(master, b'/quit\\r')
try: proc.wait(timeout=3)
except subprocess.TimeoutExpired: proc.terminate(); proc.wait(timeout=3)
os.close(master)
raise SystemExit(0 if all(checks.values()) else 1)
`;
try {
	const result = spawnSync("python3", ["-c", script], { encoding: "utf8", timeout: 30_000 });
	process.stdout.write(result.stdout ?? "");
	process.stderr.write(result.stderr ?? "");
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
} finally { rmSync(dir, { recursive: true, force: true }); }
