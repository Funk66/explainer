// Renders agent events to a terminal.
import type { AgentEvent, Emit } from './events.ts';
import * as ui from './ui.ts';

export function terminalRenderer(opts: { showReasoning: boolean }): Emit {
  let mode: 'none' | 'reasoning' | 'content' = 'none';
  let reasoningChars = 0;
  const endStream = () => {
    if (mode !== 'none') { ui.clearStatus(); ui.write('\n'); mode = 'none'; }
  };
  return (e: AgentEvent) => {
    switch (e.type) {
      case 'phase':
        endStream();
        ui.line(ui.bold(`\n▶ ${e.label}`));
        break;
      case 'step':
        endStream();
        reasoningChars = 0;
        ui.line(ui.magenta(`\n── ${e.agent} · step ${e.step}/${e.maxSteps} ${'─'.repeat(30)}`));
        break;
      case 'reasoning':
        reasoningChars += e.text.length;
        if (opts.showReasoning) {
          if (mode !== 'reasoning') { ui.clearStatus(); ui.write(ui.dim('💭 ')); mode = 'reasoning'; }
          ui.write(ui.dim(e.text));
        } else {
          ui.status(ui.dim(`  thinking… ${reasoningChars.toLocaleString()} chars`));
        }
        break;
      case 'content':
        if (mode !== 'content') { if (mode !== 'none') ui.write('\n'); ui.clearStatus(); mode = 'content'; }
        ui.write(e.text);
        break;
      case 'stream-end':
        endStream();
        break;
      case 'tool-progress':
        ui.status(ui.cyan(`  → ${e.name} `) + ui.dim(`(${(e.bytes / 1024).toFixed(1)} KB streamed)`));
        break;
      case 'waiting':
        ui.status(ui.dim(`  … waiting for the model (${e.elapsedSeconds}s elapsed, ${e.idleSeconds}s since last output)`));
        break;
      case 'usage':
        ui.line(ui.dim(`   tokens: ${e.promptTokens} in / ${e.completionTokens} out`));
        break;
      case 'tool-call':
        endStream();
        ui.line(ui.cyan(`  → ${e.name}`) + (e.summary ? ui.dim(` ${e.summary}`) : ''));
        break;
      case 'tool-result':
        if (e.summary) ui.line(indent(e.ok ? ui.dim(e.summary) : ui.red(e.summary)));
        break;
      case 'status':
        ui.status(ui.dim(`  ${e.text}`));
        break;
      case 'build':
        ui.clearStatus();
        ui.line(e.ok ? ui.green('  ✓ build + render check passed') + ui.dim(` (${e.warnings} warning(s))`) : ui.red(`  ✗ ${e.detail ?? `${e.issues} issue(s)`}`));
        break;
      case 'note':
        endStream();
        ui.line(e.level === 'error' ? ui.red(`  ${e.text}`) : e.level === 'warn' ? ui.yellow(`  ${e.text}`) : ui.dim(`  ${e.text}`));
        break;
      case 'done':
        endStream();
        break;
    }
  };
}

function indent(s: string, max = 30) {
  const lines = s.split('\n');
  const shown = lines.slice(0, max).map((l) => `    ${l}`).join('\n');
  return lines.length > max ? `${shown}\n    … (${lines.length - max} more lines)` : shown;
}
