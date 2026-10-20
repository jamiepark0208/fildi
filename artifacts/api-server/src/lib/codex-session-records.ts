import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
// Shared bounded input for local usage/activity readers. Contents never leave these readers.
type Records = { header: string; tail: string };
let cache: { at: number; root: string; rows: Records[] } | null = null;
export function codexSessionRecords(now = Date.now(), root = join(homedir(), ".codex/sessions")): Records[] {
  if (cache && cache.root === root && now >= cache.at && now - cache.at < 5_000) return cache.rows;
  const files: { path: string; modified: number }[] = [];
  // Session folders use start dates. Older resumed chats still need to be discovered.
  const dirs = (path: string, pattern: RegExp) => {
    try { return readdirSync(path, {withFileTypes:true}).filter(d => d.isDirectory() && pattern.test(d.name)).map(d => join(path,d.name)); }
    catch { return []; }
  };
  for (const year of dirs(root, /^\d{4}$/)) for (const month of dirs(year, /^\d{2}$/)) for (const dir of dirs(month, /^\d{2}$/)) {
    try { for(const name of readdirSync(dir)) if(name.endsWith(".jsonl")) {
      const path=join(dir,name); files.push({path,modified:statSync(path).mtimeMs});
    }} catch { /* no sessions */ }
  }
  const rows: Records[]=[];
  for(const file of files.sort((a,b)=>b.modified-a.modified).slice(0,40)) {
    let fd: number | undefined;
    try {
      fd=openSync(file.path,"r");const size=statSync(file.path).size;
      const head=Buffer.alloc(Math.min(size,256*1024));const hn=readSync(fd,head,0,head.length,0);
      const start=Math.max(0,size-256*1024),buf=Buffer.alloc(size-start);const n=readSync(fd,buf,0,buf.length,start);
      const text=buf.subarray(0,n).toString("utf8");
      rows.push({header:head.subarray(0,hn).toString("utf8"),tail:start?text.slice(text.indexOf("\n")+1):text});
    } catch { /* unreadable telemetry is unknown */ } finally {if(fd!==undefined)closeSync(fd);}
  }
  cache={at:now,root,rows};return rows;
}
