// Creates/deletes the two QA accounts (e2e_alice, e2e_bob) the test suite logs
// in as. Run from the repo root with the server's DATABASE_URL set:
//   node e2e/qa-users.js create
//   node e2e/qa-users.js delete
// Always delete afterwards — server/.env points at the real shared Neon database.
const { PrismaClient } = require("../server/node_modules/@prisma/client");
const bcrypt = require("../server/node_modules/bcryptjs");

const NAMES = ["e2e_alice", "e2e_bob"];

async function main() {
  const prisma = new PrismaClient();
  if (process.argv[2] === "delete") {
    const users = await prisma.user.findMany({ where: { username: { in: NAMES } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    const del = async (label, fn) => { try { const r = await fn(); console.log("deleted", label, r.count); } catch (e) { console.log("skip", label, e.code || e.message.slice(0, 80)); } };
    await del("messages", () => prisma.message.deleteMany({ where: { OR: [{ senderId: { in: ids } }, { recipientId: { in: ids } }] } }));
    await del("oneTimePreKeys", () => prisma.oneTimePreKey.deleteMany({ where: { userId: { in: ids } } }));
    await del("signedPreKeys", () => prisma.signedPreKey.deleteMany({ where: { userId: { in: ids } } }));
    await del("identityKeys", () => prisma.identityKey.deleteMany({ where: { userId: { in: ids } } }));
    await del("users", () => prisma.user.deleteMany({ where: { id: { in: ids } } }));
  } else {
    const passwordHash = await bcrypt.hash("TestPass123!", 12);
    for (const username of NAMES) {
      const u = await prisma.user.upsert({
        where: { username },
        update: { passwordHash, emailVerified: true },
        create: { username, email: `${username}@example.invalid`, passwordHash, emailVerified: true },
      });
      console.log("ready", u.username);
    }
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
