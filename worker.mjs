import { DurableObject } from 'cloudflare:workers';
import { DeskRuntime, webhookAuthorized } from './desk-runtime.mjs';

const getDesk = env => env.DESK.getByName('ugc-desk-primary');
const security = {
  'Cache-Control':'no-store',
  'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer',
  'X-Frame-Options':'DENY'
};

export class Desk extends DurableObject {
  constructor(state,env) {
    super(state,env);
    this.runtime=new DeskRuntime(state.storage,env);
  }
  fetch(request) { return this.runtime.fetch(request); }
  async runSchedule() { await this.runtime.runSchedule(); }
}

export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if (url.pathname==='/telegram/webhook' && !webhookAuthorized(request,env))
      return new Response('Forbidden',{status:403,headers:security});
    if (url.pathname==='/telegram/webhook' || url.pathname==='/health' ||
        url.pathname==='/setup/connect' || url.pathname.startsWith('/api/')) return getDesk(env).fetch(request);
    if (url.pathname==='/setup') {
      if (request.method!=='GET') return new Response(null,{status:405,headers:security});
      url.pathname='/setup.html';
    }
    if (url.pathname==='/') url.pathname='/index.html';
    const asset=await env.ASSETS.fetch(new Request(url,request));
    const headers=new Headers(asset.headers);
    for (const [name,value] of Object.entries(security)) headers.set(name,value);
    return new Response(asset.body,{status:asset.status,headers});
  },
  async scheduled(_controller,env,ctx) {
    ctx.waitUntil(getDesk(env).runSchedule());
  }
};
