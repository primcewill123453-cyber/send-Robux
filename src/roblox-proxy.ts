const USER_HOSTS = ['https://users.roblox.com', 'https://users.roproxy.com', 'https://users.rprxy.xyz'];
const THUMB_HOSTS = ['https://thumbnails.roblox.com', 'https://thumbnails.roproxy.com', 'https://thumbnails.rprxy.xyz'];
const FRIEND_HOSTS = ['https://friends.roblox.com', 'https://friends.roproxy.com', 'https://friends.rprxy.xyz'];

export type ProxyResult = { status: number; body: string };

export class RobloxProxy {
  async search(keyword: string, limit = 10) {
    return this.get(USER_HOSTS, `/v1/users/search?keyword=${encodeURIComponent(keyword)}&limit=${limit}`);
  }
  async lookupByUsernames(usernames: string[]) {
    return this.post(USER_HOSTS, '/v1/usernames/users', { usernames, excludeBannedUsers: false });
  }
  async lookupById(id: string) {
    return this.get(USER_HOSTS, `/v1/users/${id}`);
  }
  async avatars(userIds: string) {
    return this.get(THUMB_HOSTS, `/v1/users/avatar-headshot?userIds=${userIds}&size=150x150&format=Png&isCircular=true`);
  }
  async friendCount(id: string) {
    return this.get(FRIEND_HOSTS, `/v1/users/${id}/friends/count`);
  }
  async resolveByName(username: string): Promise<ProxyResult> {
    const r = await this.post(USER_HOSTS, '/v1/usernames/users', { usernames: [username], excludeBannedUsers: false });
    if (r.status !== 200) return r;
    try {
      const j = JSON.parse(r.body);
      const f = (j.data || [])[0];
      if (!f) return { status: 404, body: JSON.stringify({ data: [] }) };
      return { status: 200, body: JSON.stringify({ data: [{ id: f.id, name: f.name, displayName: f.displayName }] }) };
    } catch {
      return { status: 502, body: r.body };
    }
  }
  private async get(hosts: string[], path: string): Promise<ProxyResult> {
    let last: ProxyResult = { status: 502, body: '{"error":"all hosts failed"}' };
    for (const h of hosts) {
      try {
        const res = await fetch(`${h}${path}`);
        const body = await res.text();
        if (res.ok) return { status: res.status, body };
        last = { status: res.status, body };
      } catch (e) {
        last = { status: 502, body: JSON.stringify({ error: String(e) }) };
      }
    }
    return last;
  }
  private async post(hosts: string[], path: string, body: unknown): Promise<ProxyResult> {
    let last: ProxyResult = { status: 502, body: '{"error":"all hosts failed"}' };
    for (const h of hosts) {
      try {
        const res = await fetch(`${h}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        if (res.ok) return { status: res.status, body: text };
        last = { status: res.status, body: text };
      } catch (e) {
        last = { status: 502, body: JSON.stringify({ error: String(e) }) };
      }
    }
    return last;
  }
  static from() { return new RobloxProxy(); }
}
