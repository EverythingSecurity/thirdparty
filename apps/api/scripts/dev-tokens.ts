/**
 * Dev-only: mint a staff JWT for the seeded admin and issue a vendor invite
 * token for the seeded vendor's assessment. Prints both to stdout.
 *
 * Usage:
 *   npm run --workspace=@vsa/api dev:tokens
 *
 * Refuses to run when NODE_ENV=production. Never expose the equivalent as an
 * HTTP endpoint — the whole point of the vendor-token model (blueprint §5.1)
 * is that raw tokens live server-side for exactly one exchange with an admin.
 */
import { PrismaClient } from '@prisma/client';
import { loadEnv } from '../src/env.js';
import { mintStaffJwtForDev } from '../src/lib/jwt.js';
import { issueVendorToken } from '../src/lib/vendor-token.js';

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    // eslint-disable-next-line no-console
    console.error('dev-tokens refuses to run in production');
    process.exit(2);
  }

  const env = loadEnv();
  const prisma = new PrismaClient();
  try {
    const admin = await prisma.user.findFirst({
      where: { email: 'admin@demo.local', role: 'admin' },
    });
    if (!admin) throw new Error('Seed data missing: run `npm run db:seed` first.');

    const jwt = await mintStaffJwtForDev(
      {
        sub: admin.id,
        org_id: admin.organizationId,
        role: admin.role,
        email: admin.email,
      },
      { issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE, secret: env.JWT_DEV_SECRET },
      15 * 60,
    );

    // Find or create a demo assessment + invite.
    const vendor = await prisma.vendor.findFirst({
      where: { organizationId: admin.organizationId, name: 'Acme Corp' },
    });
    if (!vendor) throw new Error('Seed data missing: no demo vendor.');

    const template = await prisma.checklistTemplate.findFirst({
      where: { organizationId: admin.organizationId },
    });
    if (!template) throw new Error('Seed data missing: no checklist template.');

    let assessment = await prisma.assessment.findFirst({
      where: { vendorId: vendor.id, checklistTemplateId: template.id },
    });
    if (!assessment) {
      assessment = await prisma.assessment.create({
        data: {
          organizationId: admin.organizationId,
          vendorId: vendor.id,
          checklistTemplateId: template.id,
          status: 'sent',
          assignedById: admin.id,
          assignedAt: new Date(),
        },
      });
    }

    const { raw, hash } = issueVendorToken(env.VENDOR_TOKEN_PEPPER);
    const expires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    await prisma.vendorInvite.create({
      data: {
        vendorId: vendor.id,
        assessmentId: assessment.id,
        tokenHash: hash,
        issuedById: admin.id,
        expiresAt: expires,
      },
    });

    // eslint-disable-next-line no-console
    console.info('\n=== Dev tokens ===');
    // eslint-disable-next-line no-console
    console.info('\nStaff JWT (admin):');
    // eslint-disable-next-line no-console
    console.info(jwt);
    // eslint-disable-next-line no-console
    console.info('\nVendor invite token (expires', expires.toISOString(), '):');
    // eslint-disable-next-line no-console
    console.info(raw);
    // eslint-disable-next-line no-console
    console.info('\nExample:');
    // eslint-disable-next-line no-console
    console.info(`  curl -H "Authorization: Bearer ${jwt}" http://localhost:4000/me`);
    // eslint-disable-next-line no-console
    console.info(`  curl -H "Authorization: Bearer ${raw}" http://localhost:4000/vendor/me`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('dev-tokens failed:', err);
  process.exit(1);
});
