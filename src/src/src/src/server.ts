import express, { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import { RobloxProxy } from './roblox-proxy.js';
import { generateKeys, listKeys, deleteKey, unlockKey, redeemKey, validateUserSession, linkDiscordToSession, adminLogin, isAdmin, getPaused, setPaused } from './key-store.js';
import { DISCORD_ENABLED, buildAuthUrl, exchangeCode, fetchSelf, fetchGuildMember, findGuildMemberByName } from './discord.js';

const app = express();
app.use(express.json());
app.set('trust proxy', true);

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin || '';
  const allow = ALLOWED_ORIGINS.includes('*') || (origin && ALLOWED_ORIGINS.includes(origin));
  if (allow) { res.setHeader('Access-Control-Allow-Origin', origin || '*'); res.setHeader('Access-Control-Allow-Credentials', 'true'); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Admin-Token,X-User-Token');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

const proxy = RobloxProxy.from();
const PORT = Number(process.env.PORT || 3000);
const send = (res: Response, p: { status: number; body: string }) => res.status(p.status).type('application/json').send(p.body);
const clientIp = (req: Request) => ((req.headers['x-forwarded-for'] || '') as string).split(',')[0]?.trim() || req.ip || 'unknown';
const requireAdmin = async (req: Request, res: Response) => {
  const token = (req.headers['x-admin-token'] as string) || (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!(await isAdmin(token))) { res.status(401).json({ error: 'unauthorized' }); return false; }
  return true;
};

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/search', async (req, res) => { const k = String(req.query.keyword||''); if(!k) return res.status(400).json({error:'keyword required'}); try{send(res,await proxy.search(k,Number(req.query.limit||10)))}catch(e){res.status(502).json({error:String(e)})} });
app.post('/lookup', async (req, res) => { const u=req.body?.usernames||[]; if(!u.length) return res.status(400).json({error:'usernames required'}); try{send(res,await proxy.lookupByUsernames(u))}catch(e){res.status(502).json({error:String(e)})} });
app.get('/user/:id', async (req, res) => { try{send(res,await proxy.lookupById(req.params.id))}catch(e){res.status(502).json({error:String(e)})} });
app.get('/avatars', async (req, res) => { const u=String(req.query.userIds||''); if(!u) return res.status(400).json({error:'userIds required'}); try{send(res,await proxy.avatars(u))}catch(e){res.status(502).json({error:String(e)})} });
app.get('/friends/count/:id', async (req, res) => { try{send(res,await proxy.friendCount(req.params.id))}catch(e){res.status(502).json({error:String(e)})} });
app.get('/resolve/:username', async (req, res) => { try{send(res,await proxy.resolveByName(req.params.username))}catch(e){res.status(502).json({error:String(e)})} });
app.get('/site/status', async (_req, res) => { try{res.json({paused:await getPaused()})}catch(e){res.status(500).json({error:String(e)})} });

app.post('/keys/redeem', async (req, res) => {
  const code = String(req.body?.code||'').trim();
  const discordUsername = String(req.body?.discordUsername||'').trim();
  if (!code) return res.status(400).json({error:'code required'});
  try {
    if (await getPaused()) return res.status(503).json({error:'site is paused'});
    let discordMatch = null;
    if (discordUsername && DISCORD_ENABLED) {
      try { discordMatch = await findGuildMemberByName(discordUsername); } catch {}
      if (!discordMatch) return res.status(403).json({error:'discord-not-found'});
    }
    const result = await redeemKey(code, clientIp(req));
    if (!result.ok) return res.status(403).json({error:result.reason});
    if (discordMatch) { try { await linkDiscordToSession(result.token, {id:discordMatch.user.id,username:discordMatch.user.globalName||discordMatch.user.username,avatarUrl:discordMatch.user.avatarUrl}); } catch {} }
    res.json({token:result.token,key:result.key});
  } catch(e) { res.status(500).json({error:String(e)}); }
});

app.get('/keys/me', async (req, res) => {
  const token = (req.headers['x-user-token'] as string)||String(req.query.token||'');
  if (!token) return res.status(401).json({error:'no token'});
  try {
    const session = await validateUserSession(token, clientIp(req));
    if (!session) return res.status(401).json({error:'invalid'});
    const member = session.discord.id ? await fetchGuildMember(session.discord.id).catch(()=>null) : null;
    res.json({key:session.key,discord:session.discord,member,discordEnabled:DISCORD_ENABLED});
  } catch(e) { res.status(500).json({error:String(e)}); }
});

const discordStates = new Map<string,{token:string;createdAt:number}>();
const buildRedirectUri = (req: Request) => `${(req.headers['x-forwarded-proto'] as string)||req.protocol}://${req.headers.host}/auth/discord/callback`;

app.get('/auth/discord/login', (req, res) => {
  if (!DISCORD_ENABLED) return res.status(503).json({error:'discord not configured'});
  const token = (req.headers['x-user-token'] as string)||String(req.query.token||'');
  if (!token) return res.status(401).json({error:'redeem a key first'});
  const now = Date.now(); for (const [k,v] of discordStates) if(now-v.createdAt>600000) discordStates.delete(k);
  const state = randomBytes(16).toString('hex');
  discordStates.set(state,{token,createdAt:Date.now()});
  res.redirect(buildAuthUrl(buildRedirectUri(req),state));
});

app.get('/auth/discord/callback', async (req, res) => {
  const code = String(req.query.code||''), state = String(req.query.state||'');
  const entry = discordStates.get(state); discordStates.delete(state);
  if (!code||!entry) return res.status(400).send('Invalid Discord callback');
  try {
    const at = await exchangeCode(code, buildRedirectUri(req)); if (!at) throw new Error('exchange failed');
    const self = await fetchSelf(at); if (!self) throw new Error('fetch self failed');
    await linkDiscordToSession(entry.token,{id:self.id,username:self.globalName||self.username,avatarUrl:self.avatarUrl});
    res.send(`<!doctype html><meta charset=utf-8><body style="background:#000;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:16px"><div style="font-size:20px;font-weight:700">Discord linked!</div><div style="color:#8a8a8a">You can close this window.</div><script>setTimeout(()=>{try{window.opener&&window.opener.postMessage('discord-linked','*');window.close()}catch(e){}},600)</script></body>`);
  } catch(e) { res.status(500).send(`Discord login failed: ${String(e)}`); }
});

app.post('/admin/login', async (req, res) => { const p=String(req.body?.password||''); if(!p) return res.status(400).json({error:'password required'}); try{const t=await adminLogin(p); if(!t) return res.status(401).json({error:'invalid password'}); res.json({token:t});}catch(e){res.status(500).json({error:String(e)})} });
app.get('/admin/keys', async (req, res) => { if(!(await requireAdmin(req,res))) return; try{res.json({keys:await listKeys()})}catch(e){res.status(500).json({error:String(e)})} });
app.post('/admin/keys', async (req, res) => { if(!(await requireAdmin(req,res))) return; try{res.json({keys:await generateKeys(Math.max(1,Math.min(100,Number(req.body?.count||1))),String(req.body?.note||''))})}catch(e){res.status(500).json({error:String(e)})} });
app.delete('/admin/keys/:code', async (req, res) => { if(!(await requireAdmin(req,res))) return; try{res.json({ok:await deleteKey(req.params.code)})}catch(e){res.status(500).json({error:String(e)})} });
app.post('/admin/keys/:code/unlock', async (req, res) => { if(!(await requireAdmin(req,res))) return; try{res.json({ok:await unlockKey(req.params.code)})}catch(e){res.status(500).json({error:String(e)})} });
app.post('/admin/site/pause', async (req, res) => { if(!(await requireAdmin(req,res))) return; const p=!!req.body?.paused; try{await setPaused(p);res.json({ok:true,paused:p})}catch(e){res.status(500).json({error:String(e)})} });

app.listen(PORT, () => console.log(`🚀 Robux proxy ready on port ${PORT}`));
