// Reset (or create) the admin login inside the running API container.
// Used by:  .\windows\run-tunnel.ps1 -ResetPassword
// Reads RESET_EMAIL / RESET_PASSWORD from the environment; never prints the password.
const core = await import(process.env.CORE_PATH || '/app/packages/core/dist/index.js');
const { prisma, hashPassword } = core;
const email = (process.env.RESET_EMAIL || '').toLowerCase().trim();
const pw = process.env.RESET_PASSWORD || '';
if (!email || pw.length < 8) {
  console.error('RESET_EMAIL and RESET_PASSWORD (8+ characters) are required');
  process.exit(2);
}
const passwordHash = await hashPassword(pw);
const u = await prisma.user.upsert({
  where: { email },
  update: { passwordHash, role: 'ADMIN' },
  create: { email, name: 'Administrator', passwordHash, role: 'ADMIN' },
});
console.log('RESET_OK ' + u.email);
await prisma.$disconnect();
