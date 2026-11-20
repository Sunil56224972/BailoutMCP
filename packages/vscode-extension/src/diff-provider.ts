import * as vscode from 'vscode';

export const BAILOUT_DIFF_SCHEME = 'bailout-fix';

/**
 * Virtual document provider for rendering native side-by-side VS Code diffs
 * (`vscode.diff`) of silently pre-solved BailoutMCP heavy-model fixes.
 */
export class BailoutDiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();

  readonly onDidChange = this.emitter.event;

  setContent(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this.emitter.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  dispose(): void {
    this.emitter.dispose();
    this.contents.clear();
  }
}
