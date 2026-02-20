import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as url from 'url';
import * as vscode from 'vscode';
import {
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
  OAUTH_AUTH_URL,
  OAUTH_TOKEN_URL,
  OAUTH_USERINFO_URL,
  OAUTH_CALLBACK_PATH,
  IFLOW_DIR,
  OAUTH_CREDS_PATH,
  SETTINGS_PATH,
  TOKEN_REFRESH_THRESHOLD_MS,
  OAUTH_CALLBACK_TIMEOUT_MS,
} from './authConstants';

/** Shape of the persisted OAuth credentials file (~/.iflow/oauth_creds.json). */
export interface OAuthCredentials {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expiry_date: number;
  readonly token_type: string;
  readonly scope: string;
  readonly apiKey: string;
  readonly userId: string;
  readonly userName: string;
  readonly avatar: string;
  readonly email: string;
  readonly phone: string;
}

interface TokenResponse {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in: number;
  readonly token_type: string;
  readonly scope: string;
}

interface UserInfoResponse {
  readonly apiKey: string;
  readonly userId: string;
  readonly userName: string;
  readonly avatar: string;
  readonly email: string;
  readonly phone: string;
}

export class AuthService {
  private callbackServer: http.Server | null = null;
  private outputChannel: vscode.OutputChannel | null = null;

  // ── Public API ────────────────────────────────────────────────

  /**
   * Start the full OAuth login flow:
   * 1. Start local callback server on a dynamic port
   * 2. Open browser to iflow.cn OAuth page
   * 3. Wait for callback with authorization code
   * 4. Exchange code for tokens
   * 5. Fetch user info (including apiKey)
   * 6. Save credentials to ~/.iflow/
   */
  async startLogin(): Promise<void> {
    // Prevent concurrent login flows
    if (this.callbackServer) {
      throw new Error('A login flow is already in progress');
    }

    const state = crypto.randomBytes(32).toString('hex');

    let callbackResult: { code: string; port: number };
    try {
      callbackResult = await this.startCallbackServer(state);
    } finally {
      this.stopCallbackServer();
    }

    const { code, port } = callbackResult;
    const redirectUri = `http://localhost:${port}${OAUTH_CALLBACK_PATH}`;

    // Exchange code for tokens
    const tokens = await this.exchangeCodeForTokens(code, redirectUri);

    // Fetch user info
    const userInfo = await this.fetchUserInfo(tokens.access_token);

    // Build credentials (immutable object)
    const credentials: OAuthCredentials = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: Date.now() + tokens.expires_in * 1000,
      token_type: tokens.token_type,
      scope: tokens.scope,
      apiKey: userInfo.apiKey,
      userId: userInfo.userId,
      userName: userInfo.userName,
      avatar: userInfo.avatar,
      email: userInfo.email,
      phone: userInfo.phone,
    };

    // Persist credentials
    this.writeCredentials(credentials);
    this.updateSettings(credentials.apiKey);
    this.log(`Login successful for user: ${credentials.userName}`);
  }

  /** Clear stored OAuth credentials. */
  logout(): void {
    try {
      if (fs.existsSync(OAUTH_CREDS_PATH)) {
        fs.unlinkSync(OAUTH_CREDS_PATH);
      }
      this.clearSettings();
      this.log('Logged out successfully');
    } catch (err) {
      this.log(`Logout error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Ensure the access token is valid; refresh if expiring within 24 hours.
   * Returns true if auth is valid, false if not logged in or refresh failed.
   */
  async ensureValidToken(): Promise<boolean> {
    const creds = this.readCredentials();
    if (!creds) {
      return false;
    }

    const timeUntilExpiry = creds.expiry_date - Date.now();
    if (timeUntilExpiry > TOKEN_REFRESH_THRESHOLD_MS) {
      return true;
    }

    if (timeUntilExpiry <= 0) {
      // Token fully expired — clear and force re-login
      this.log('OAuth token expired, clearing credentials');
      this.logout();
      return false;
    }

    // Token expiring soon — attempt refresh
    try {
      this.log('OAuth token expiring soon, refreshing...');
      const newTokens = await this.refreshAccessToken(creds.refresh_token);
      const updatedCreds: OAuthCredentials = {
        ...creds,
        access_token: newTokens.access_token,
        refresh_token: newTokens.refresh_token,
        expiry_date: Date.now() + newTokens.expires_in * 1000,
        token_type: newTokens.token_type,
        scope: newTokens.scope,
      };
      this.writeCredentials(updatedCreds);
      this.updateSettings(updatedCreds.apiKey);
      this.log('OAuth token refreshed successfully');
      return true;
    } catch (err) {
      this.log(`Token refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** Check if OAuth credentials exist on disk. */
  isLoggedIn(): boolean {
    return this.readCredentials() !== null;
  }

  dispose(): void {
    this.stopCallbackServer();
  }

  // ── Private: Logging ──────────────────────────────────────────

  private log(message: string): void {
    if (!this.outputChannel) {
      this.outputChannel = vscode.window.createOutputChannel('IFlow Auth');
    }
    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${timestamp}] ${message}`);
  }

  // ── Private: Credential I/O ───────────────────────────────────

  private readCredentials(): OAuthCredentials | null {
    try {
      if (!fs.existsSync(OAUTH_CREDS_PATH)) {
        return null;
      }
      const content = fs.readFileSync(OAUTH_CREDS_PATH, 'utf-8');
      const parsed = JSON.parse(content);
      // Validate required fields exist
      if (!parsed.access_token || !parsed.refresh_token || !parsed.apiKey) {
        return null;
      }
      return parsed as OAuthCredentials;
    } catch {
      return null;
    }
  }

  private writeCredentials(creds: OAuthCredentials): void {
    if (!fs.existsSync(IFLOW_DIR)) {
      fs.mkdirSync(IFLOW_DIR, { recursive: true });
    }
    const content = JSON.stringify(creds, null, 2);
    if (process.platform === 'win32') {
      fs.writeFileSync(OAUTH_CREDS_PATH, content, 'utf-8');
    } else {
      fs.writeFileSync(OAUTH_CREDS_PATH, content, { encoding: 'utf-8', mode: 0o600 });
    }
  }

  private updateSettings(apiKey: string): void {
    try {
      let settings: Record<string, unknown> = {};
      if (fs.existsSync(SETTINGS_PATH)) {
        try {
          settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
        } catch {
          // If parse fails, start fresh
        }
      }
      const updated = {
        ...settings,
        selectedAuthType: 'oauth-iflow',
        apiKey,
      };
      if (!fs.existsSync(IFLOW_DIR)) {
        fs.mkdirSync(IFLOW_DIR, { recursive: true });
      }
      const content = JSON.stringify(updated, null, 2);
      if (process.platform === 'win32') {
        fs.writeFileSync(SETTINGS_PATH, content, 'utf-8');
      } else {
        fs.writeFileSync(SETTINGS_PATH, content, { encoding: 'utf-8', mode: 0o600 });
      }
    } catch (err) {
      this.log(`Failed to update settings: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private clearSettings(): void {
    try {
      if (!fs.existsSync(SETTINGS_PATH)) {
        return;
      }
      const settings: Record<string, unknown> = JSON.parse(
        fs.readFileSync(SETTINGS_PATH, 'utf-8')
      );
      delete settings.selectedAuthType;
      delete settings.apiKey;
      const content = JSON.stringify(settings, null, 2);
      if (process.platform === 'win32') {
        fs.writeFileSync(SETTINGS_PATH, content, 'utf-8');
      } else {
        fs.writeFileSync(SETTINGS_PATH, content, { encoding: 'utf-8', mode: 0o600 });
      }
    } catch (err) {
      this.log(`Failed to clear settings: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Private: Callback Server ──────────────────────────────────

  /**
   * Start a local HTTP server on a dynamic port and wait for the OAuth callback.
   * Opens the browser to the OAuth authorization URL.
   * Returns the authorization code and the port the server is listening on.
   */
  private startCallbackServer(expectedState: string): Promise<{ code: string; port: number }> {
    return new Promise<{ code: string; port: number }>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const parsed = url.parse(req.url || '', true);

        if (parsed.pathname !== OAUTH_CALLBACK_PATH) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }

        const code = parsed.query.code as string | undefined;
        const state = parsed.query.state as string | undefined;

        if (!code || !state) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body><h2>Authentication failed</h2><p>Missing code or state parameter.</p></body></html>');
          reject(new Error('Missing code or state in OAuth callback'));
          return;
        }

        if (state !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body><h2>Authentication failed</h2><p>State mismatch (possible CSRF attack).</p></body></html>');
          reject(new Error('OAuth state mismatch'));
          return;
        }

        // Success — respond to the browser
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body style="font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;">
          <div style="text-align:center;">
            <h2>Authentication Successful</h2>
            <p>You can close this tab and return to VS Code.</p>
          </div>
        </body></html>`);

        const port = (server.address() as { port: number }).port;
        resolve({ code, port });
      });

      this.callbackServer = server;

      // Timeout — reject if callback never arrives
      const timeout = setTimeout(() => {
        this.stopCallbackServer();
        reject(new Error('OAuth callback timed out (2 minutes). Please try again.'));
      }, OAUTH_CALLBACK_TIMEOUT_MS);

      server.on('close', () => clearTimeout(timeout));

      // Listen on port 0 (OS picks an available port)
      server.listen(0, 'localhost', () => {
        const addr = server.address() as { port: number };
        const port = addr.port;
        this.log(`OAuth callback server listening on port ${port}`);

        // Construct the OAuth URL and open the browser
        const authUrl = `${OAUTH_AUTH_URL}?loginMethod=phone&type=phone&redirect=${encodeURIComponent(`http://localhost:${port}${OAUTH_CALLBACK_PATH}`)}&state=${expectedState}&client_id=${OAUTH_CLIENT_ID}`;
        this.log(`Opening browser: ${authUrl}`);
        vscode.env.openExternal(vscode.Uri.parse(authUrl));
      });

      server.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to start OAuth callback server: ${err.message}`));
      });
    });
  }

  private stopCallbackServer(): void {
    if (this.callbackServer) {
      try {
        this.callbackServer.close();
      } catch {
        // Ignore close errors
      }
      this.callbackServer = null;
    }
  }

  // ── Private: OAuth API Calls ──────────────────────────────────

  private async exchangeCodeForTokens(code: string, redirectUri: string): Promise<TokenResponse> {
    const response = await this.httpsPost(OAUTH_TOKEN_URL, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
    });

    if (!response.access_token) {
      throw new Error(`Token exchange failed: ${JSON.stringify(response)}`);
    }

    return {
      access_token: response.access_token as string,
      refresh_token: response.refresh_token as string,
      expires_in: response.expires_in as number,
      token_type: (response.token_type as string) || 'bearer',
      scope: (response.scope as string) || 'read',
    };
  }

  private async fetchUserInfo(accessToken: string): Promise<UserInfoResponse> {
    const response = await this.httpsGet(
      `${OAUTH_USERINFO_URL}?accessToken=${encodeURIComponent(accessToken)}`
    );

    const data = (response.data ?? response) as Record<string, unknown>;
    if (!data.apiKey) {
      throw new Error(`Failed to fetch user info: ${JSON.stringify(response)}`);
    }

    return {
      apiKey: data.apiKey as string,
      userId: (data.userId as string) || '',
      userName: (data.userName as string) || '',
      avatar: (data.avatar as string) || '',
      email: (data.email as string) || '',
      phone: (data.phone as string) || '',
    };
  }

  private async refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
    const response = await this.httpsPost(OAUTH_TOKEN_URL, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
    });

    if (!response.access_token) {
      throw new Error(`Token refresh failed: ${JSON.stringify(response)}`);
    }

    return {
      access_token: response.access_token as string,
      refresh_token: (response.refresh_token as string) || refreshToken,
      expires_in: response.expires_in as number,
      token_type: (response.token_type as string) || 'bearer',
      scope: (response.scope as string) || 'read',
    };
  }

  // ── Private: HTTPS Helpers ────────────────────────────────────

  private httpsPost(requestUrl: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const body = Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');

      const parsed = new url.URL(requestUrl);
      const options: https.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid JSON response: ${data.substring(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private httpsGet(requestUrl: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const parsed = new url.URL(requestUrl);
      const options: https.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: 'GET',
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid JSON response: ${data.substring(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }
}
