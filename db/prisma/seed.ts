/**
 * Seed script — reference SCF Third-Party Management controls + demo tenant.
 * Reference: SOLUTION_BLUEPRINT.md §1.2.
 *
 * Idempotent: safe to run multiple times. Uses upserts keyed on the natural
 * unique constraints (control_code, organization_id + name, etc.).
 */
import { PrismaClient, ControlSource } from '@prisma/client';

const prisma = new PrismaClient();

interface SeedControl {
  code: string;
  title: string;
  description: string;
  weight: number;
  routes: Array<'cyber_reviewer' | 'legal_reviewer' | 'risk_manager'>;
  sampleQuestion: string;
}

// SCF 2026.1 Third-Party Management domain — blueprint §1.2.
const TPM_CONTROLS: SeedControl[] = [
  {
    code: 'TPM-01',
    title: 'Third-Party Management',
    description: 'Program-level controls governing third-party relationships.',
    weight: 10,
    routes: ['cyber_reviewer', 'risk_manager'],
    sampleQuestion: 'Do you maintain a documented third-party risk management program?',
  },
  {
    code: 'TPM-02',
    title: 'Third-Party Criticality Assessments',
    description: 'Criticality tiering of third parties based on business impact.',
    weight: 9,
    routes: ['risk_manager'],
    sampleQuestion:
      'Have you conducted a criticality assessment of your third-party dependencies within the past 12 months?',
  },
  {
    code: 'TPM-04.1',
    title: 'Third-Party Risk Assessments & Approvals',
    description: 'Risk-based approval workflow for engaging third parties.',
    weight: 9,
    routes: ['cyber_reviewer', 'risk_manager'],
    sampleQuestion:
      'Do you require a security risk assessment prior to onboarding any third party with access to sensitive data?',
  },
  {
    code: 'TPM-04.4',
    title: 'Third-Party Processing/Storage/Service Locations',
    description: 'Awareness and control of where data is processed, stored, and serviced.',
    weight: 10,
    routes: ['cyber_reviewer', 'legal_reviewer'],
    sampleQuestion:
      'Can you enumerate all geographic locations where your subprocessors process or store customer data?',
  },
  {
    code: 'TPM-05',
    title: 'Third-Party Contract Requirements',
    description: 'Security and privacy clauses in third-party contracts.',
    weight: 10,
    routes: ['legal_reviewer'],
    sampleQuestion:
      'Do your third-party contracts include mandatory security, privacy, and data-handling clauses?',
  },
  {
    code: 'TPM-05.1',
    title: 'Security Compromise Notification Agreements',
    description: 'Contractual breach-notification SLAs.',
    weight: 9,
    routes: ['legal_reviewer', 'cyber_reviewer'],
    sampleQuestion:
      'Does the contract require the third party to notify you of a security compromise within a defined SLA (e.g. 72 hours)?',
  },
  {
    code: 'TPM-06',
    title: 'Third-Party Personnel Security',
    description: 'Background screening and access controls for third-party personnel.',
    weight: 9,
    routes: ['cyber_reviewer'],
    sampleQuestion:
      'Do you require background screening for third-party personnel who access your systems or data?',
  },
  {
    code: 'TPM-09',
    title: 'Third-Party Deficiency Remediation',
    description: 'Tracking and remediation of identified third-party deficiencies.',
    weight: 9,
    routes: ['cyber_reviewer', 'risk_manager'],
    sampleQuestion:
      'Do you have a formal process for tracking and remediating security deficiencies identified in third parties?',
  },
  {
    code: 'TPM-11',
    title: 'Third-Party Incident Response & Recovery Capabilities',
    description: 'Assessment of third-party IR/DR maturity.',
    weight: 8,
    routes: ['cyber_reviewer'],
    sampleQuestion:
      'Do your critical third parties maintain a tested incident response and disaster recovery capability?',
  },
];

async function main() {
  console.info('[seed] starting…');

  // --- Demo organization ---
  const org = await prisma.organization.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    update: { name: 'Demo Corp' },
    create: {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Demo Corp',
    },
  });
  console.info(`[seed] organization: ${org.name}`);

  // --- Demo admin (needed for control_weight_history FK if we later insert one) ---
  const admin = await prisma.user.upsert({
    where: { organizationId_email: { organizationId: org.id, email: 'admin@demo.local' } },
    update: { fullName: 'Demo Admin', role: 'admin', isActive: true },
    create: {
      organizationId: org.id,
      email: 'admin@demo.local',
      fullName: 'Demo Admin',
      role: 'admin',
    },
  });
  console.info(`[seed] user: ${admin.email} (${admin.role})`);

  // --- Reviewer users (one per reviewer role) ---
  const cyber = await prisma.user.upsert({
    where: { organizationId_email: { organizationId: org.id, email: 'cyber@demo.local' } },
    update: { fullName: 'Demo Cyber Reviewer', role: 'cyber_reviewer', isActive: true },
    create: {
      organizationId: org.id,
      email: 'cyber@demo.local',
      fullName: 'Demo Cyber Reviewer',
      role: 'cyber_reviewer',
    },
  });
  const legal = await prisma.user.upsert({
    where: { organizationId_email: { organizationId: org.id, email: 'legal@demo.local' } },
    update: { fullName: 'Demo Legal Reviewer', role: 'legal_reviewer', isActive: true },
    create: {
      organizationId: org.id,
      email: 'legal@demo.local',
      fullName: 'Demo Legal Reviewer',
      role: 'legal_reviewer',
    },
  });
  const riskMgr = await prisma.user.upsert({
    where: { organizationId_email: { organizationId: org.id, email: 'risk@demo.local' } },
    update: { fullName: 'Demo Risk Manager', role: 'risk_manager', isActive: true },
    create: {
      organizationId: org.id,
      email: 'risk@demo.local',
      fullName: 'Demo Risk Manager',
      role: 'risk_manager',
    },
  });
  console.info(`[seed] reviewers: ${cyber.email}, ${legal.email}, ${riskMgr.email}`);

  // --- Control domain ---
  const domain = await prisma.controlDomain.upsert({
    where: { organizationId_name: { organizationId: org.id, name: 'Third-Party Management' } },
    update: { sortOrder: 10 },
    create: {
      organizationId: org.id,
      name: 'Third-Party Management',
      sortOrder: 10,
    },
  });

  // --- Controls + one question each + routing rules ---
  for (const c of TPM_CONTROLS) {
    const control = await prisma.control.upsert({
      where: { organizationId_controlCode: { organizationId: org.id, controlCode: c.code } },
      update: {
        title: c.title,
        description: c.description,
        currentWeight: c.weight,
        source: ControlSource.scf,
        frameworkRef: 'SCF 2026.1',
        controlDomainId: domain.id,
      },
      create: {
        organizationId: org.id,
        controlDomainId: domain.id,
        controlCode: c.code,
        title: c.title,
        description: c.description,
        source: ControlSource.scf,
        frameworkRef: 'SCF 2026.1',
        currentWeight: c.weight,
      },
    });

    // Idempotent question upsert: one demo question per control.
    // Use findFirst + create/update since no natural unique on (control, question_text).
    const existingQuestion = await prisma.question.findFirst({
      where: { organizationId: org.id, controlId: control.id, questionText: c.sampleQuestion },
    });
    if (!existingQuestion) {
      await prisma.question.create({
        data: {
          organizationId: org.id,
          controlId: control.id,
          questionText: c.sampleQuestion,
          requiresEvidence: false,
        },
      });
    }

    // Routing rules — idempotent by (control_id, role) unique.
    for (const role of c.routes) {
      await prisma.routingRule.upsert({
        where: { controlId_role: { controlId: control.id, role } },
        update: {},
        create: { controlId: control.id, role },
      });
    }
  }
  console.info(`[seed] ${TPM_CONTROLS.length} controls + questions + routing rules`);

  // --- Standard checklist template bundling all TPM questions ---
  const templateName = 'Standard Third-Party VSA';
  let template = await prisma.checklistTemplate.findFirst({
    where: { organizationId: org.id, name: templateName },
  });
  if (!template) {
    template = await prisma.checklistTemplate.create({
      data: {
        organizationId: org.id,
        name: templateName,
        version: 1,
        isActive: true,
      },
    });
  }
  const allQuestions = await prisma.question.findMany({
    where: { organizationId: org.id },
    orderBy: { createdAt: 'asc' },
  });
  for (const [idx, q] of allQuestions.entries()) {
    await prisma.checklistTemplateQuestion.upsert({
      where: {
        checklistTemplateId_questionId: {
          checklistTemplateId: template.id,
          questionId: q.id,
        },
      },
      update: { sortOrder: idx },
      create: {
        checklistTemplateId: template.id,
        questionId: q.id,
        sortOrder: idx,
      },
    });
  }
  console.info(`[seed] checklist template: ${template.name} (${allQuestions.length} questions)`);

  // --- Demo vendor ---
  const vendor = await prisma.vendor.upsert({
    where: { id: '00000000-0000-0000-0000-000000000010' },
    update: { name: 'Acme Corp', primaryContactEmail: 'security@acme.local' },
    create: {
      id: '00000000-0000-0000-0000-000000000010',
      organizationId: org.id,
      name: 'Acme Corp',
      primaryContactEmail: 'security@acme.local',
    },
  });
  console.info(`[seed] vendor: ${vendor.name}`);

  console.info('[seed] done.');
}

main()
  .catch((err) => {
    console.error('[seed] failed', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
