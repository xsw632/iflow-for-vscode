import * as path from 'path';
import * as os from 'os';

export const OAUTH_CLIENT_ID = '10009311001';
export const OAUTH_CLIENT_SECRET = '4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW';
export const OAUTH_AUTH_URL = 'https://iflow.cn/oauth';
export const OAUTH_TOKEN_URL = 'https://iflow.cn/oauth/token';
export const OAUTH_USERINFO_URL = 'https://iflow.cn/api/oauth/getUserInfo';
export const OAUTH_CALLBACK_PATH = '/oauth2callback';
export const IFLOW_DIR = path.join(os.homedir(), '.iflow');
export const OAUTH_CREDS_PATH = path.join(IFLOW_DIR, 'oauth_creds.json');
export const SETTINGS_PATH = path.join(IFLOW_DIR, 'settings.json');
export const TOKEN_REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
export const OAUTH_CALLBACK_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
