import { readFileSync, readdirSync, readlinkSync } from "fs";

const PORT_HEX = "1F90"; // 8080 in hex

try {
  const tcp = readFileSync("/proc/net/tcp", "utf8");
  const line = tcp.split("\n").find(l => l.toUpperCase().includes(`:${PORT_HEX} `));
  if (!line) process.exit(0);
  const inode = line.trim().split(/\s+/)[9];
  if (!inode) process.exit(0);

  const socketRef = `socket:[${inode}]`;
  for (const pid of readdirSync("/proc").filter(p => /^\d+$/.test(p))) {
    try {
      const fds = readdirSync(`/proc/${pid}/fd`);
      if (fds.some(fd => { try { return readlinkSync(`/proc/${pid}/fd/${fd}`) === socketRef; } catch { return false; } })) {
        process.kill(parseInt(pid), 9);
        await new Promise(r => setTimeout(r, 800));
      }
    } catch { /* skip */ }
  }
} catch { /* /proc not available */ }
