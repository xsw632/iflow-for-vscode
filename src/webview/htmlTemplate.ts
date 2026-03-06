import * as vscode from 'vscode';

function createNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export function buildWebviewHtml(
  extensionUri: vscode.Uri,
  webview: vscode.Webview,
): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'),
  );
  const styleLinks = [
    'base.css',
    'navigation.css',
    'messages.css',
    'tools.css',
    'composer.css',
    'feedback.css',
    'panels.css',
  ]
    .map((fileName) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'media', 'styles', fileName),
      ),
    )
    .map((styleUri) => `    <link href="${styleUri}" rel="stylesheet">`)
    .join('\n');
  const faviconUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'iflow_favicon.svg'),
  );

  const nonce = createNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
${styleLinks}
    <title>IFlow</title>
</head>
<body>
    <div id="app" data-favicon-uri="${faviconUri}"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
