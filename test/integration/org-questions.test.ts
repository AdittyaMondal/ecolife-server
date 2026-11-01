import { describe, expect, it } from 'bun:test';
import { freshIpHeaders } from '@common/testing/client-ip.ts';
import { createOnboardedUser } from '@common/testing/fixtures.ts';
import { app } from '../../src/app.ts';

const TIMEOUT = 30_000;

const call = (path: string, init: RequestInit = {}) =>
  app.request(`/api/v1${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...freshIpHeaders(),
      ...(init.headers ?? {}),
    },
  });

type Envelope = {
  status: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  data: any;
  error: { code: string; message: string; details: unknown };
};

const json = async (r: Response) => (await r.json()) as unknown as Envelope;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('Custom Onboarding Questions & Answers (Part 4)', () => {
  it(
    'supports question builder CRUD, versioning on edit, and reordering (owner only)',
    async () => {
      const owner = await createOnboardedUser({ email: `corpowner-${crypto.randomUUID().slice(0, 6)}@example.test` });
      const member = await createOnboardedUser({ email: `member-${crypto.randomUUID().slice(0, 6)}@example.test` });
      const admin = await createOnboardedUser({ role: 'admin' });

      // 1. Create and approve org
      const createOrgRes = await json(
        await call('/organizations', {
          method: 'POST',
          headers: auth(owner.token),
          body: JSON.stringify({
            name: `EcoTech ${crypto.randomUUID().slice(0, 6)}`,
            type: 'industry',
          }),
        }),
      );
      expect(createOrgRes.status).toBe(true);
      const orgId = createOrgRes.data.id;
      const orgCode = createOrgRes.data.code;

      await call(`/admin/organizations/${orgId}/review`, {
        method: 'POST',
        headers: auth(admin.token),
        body: JSON.stringify({
          decision: 'approve',
          note: 'Approved for test',
          expected: { name: createOrgRes.data.name, logoUrl: null, websiteUrl: null },
        }),
      });

      // Member joins org
      await call('/organizations/join', {
        method: 'POST',
        headers: auth(member.token),
        body: JSON.stringify({ code: orgCode }),
      });

      // 2. Member cannot create questions (403)
      const memberCreateRes = await json(
        await call(`/organizations/${orgId}/questions`, {
          method: 'POST',
          headers: auth(member.token),
          body: JSON.stringify({
            prompt: 'Member question',
            type: 'text',
            required: false,
          }),
        }),
      );
      expect(memberCreateRes.status).toBe(false);
      expect(memberCreateRes.error.code).toBe('ORG_004');

      // 3. Owner creates 5 question types
      // Type 1: text
      const q1Res = await json(
        await call(`/organizations/${orgId}/questions`, {
          method: 'POST',
          headers: auth(owner.token),
          body: JSON.stringify({
            prompt: 'What department do you work in?',
            description: 'Used for departmental carbon footprint',
            type: 'text',
            required: true,
          }),
        }),
      );
      expect(q1Res.status).toBe(true);
      expect(q1Res.data.version).toBe(1);
      expect(q1Res.data.sortOrder).toBe(0);
      const q1Id = q1Res.data.id;

      // Type 2: single_choice
      const q2Res = await json(
        await call(`/organizations/${orgId}/questions`, {
          method: 'POST',
          headers: auth(owner.token),
          body: JSON.stringify({
            prompt: 'Primary commute method',
            type: 'single_choice',
            options: ['Public Transit', 'Bicycle', 'Electric Vehicle', 'Gas Car'],
            required: true,
          }),
        }),
      );
      expect(q2Res.status).toBe(true);
      expect(q2Res.data.sortOrder).toBe(1);
      const q2Id = q2Res.data.id;

      // Type 3: multiple_choice
      const q3Res = await json(
        await call(`/organizations/${orgId}/questions`, {
          method: 'POST',
          headers: auth(owner.token),
          body: JSON.stringify({
            prompt: 'Eco habits you practice',
            type: 'multiple_choice',
            options: ['Composting', 'Zero Waste', 'Solar Panels', 'Reusable Bags'],
            required: false,
          }),
        }),
      );
      expect(q3Res.status).toBe(true);
      const q3Id = q3Res.data.id;

      // Type 4: number
      const q4Res = await json(
        await call(`/organizations/${orgId}/questions`, {
          method: 'POST',
          headers: auth(owner.token),
          body: JSON.stringify({
            prompt: 'How many km is your daily commute?',
            type: 'number',
            required: false,
          }),
        }),
      );
      expect(q4Res.status).toBe(true);
      const q4Id = q4Res.data.id;

      // Type 5: yes_no
      const q5Res = await json(
        await call(`/organizations/${orgId}/questions`, {
          method: 'POST',
          headers: auth(owner.token),
          body: JSON.stringify({
            prompt: 'Do you work remotely full-time?',
            type: 'yes_no',
            required: true,
          }),
        }),
      );
      expect(q5Res.status).toBe(true);
      const q5Id = q5Res.data.id;

      // 4. List questions
      const listRes = await json(
        await call(`/organizations/${orgId}/questions`, {
          method: 'GET',
          headers: auth(owner.token),
        }),
      );
      expect(listRes.status).toBe(true);
      expect(listRes.data.length).toBe(5);

      // 5. Versioning test: Update question prompt
      const updateRes = await json(
        await call(`/organizations/${orgId}/questions/${q1Id}`, {
          method: 'PUT',
          headers: auth(owner.token),
          body: JSON.stringify({
            prompt: 'Which business department or division do you belong to?',
          }),
        }),
      );
      expect(updateRes.status).toBe(true);
      expect(updateRes.data.version).toBe(2);
      expect(updateRes.data.prompt).toBe('Which business department or division do you belong to?');

      // 6. Reorder questions
      const reorderRes = await json(
        await call(`/organizations/${orgId}/questions/reorder`, {
          method: 'POST',
          headers: auth(owner.token),
          body: JSON.stringify({
            questionIds: [q5Id, q4Id, q3Id, q2Id, q1Id],
          }),
        }),
      );
      expect(reorderRes.status).toBe(true);
      expect(reorderRes.data.ok).toBe(true);

      const reorderedList = await json(
        await call(`/organizations/${orgId}/questions`, {
          method: 'GET',
          headers: auth(owner.token),
        }),
      );
      expect(reorderedList.data[0].id).toBe(q5Id);
      expect(reorderedList.data[4].id).toBe(q1Id);

      // 7. Delete (archive) a question
      const delRes = await json(
        await call(`/organizations/${orgId}/questions/${q4Id}`, {
          method: 'DELETE',
          headers: auth(owner.token),
        }),
      );
      expect(delRes.status).toBe(true);
      expect(delRes.data.ok).toBe(true);

      const listAfterDel = await json(
        await call(`/organizations/${orgId}/questions`, {
          method: 'GET',
          headers: auth(owner.token),
        }),
      );
      expect(listAfterDel.data.length).toBe(4);
      expect(listAfterDel.data.find((q: { id: number }) => q.id === q4Id)).toBeUndefined();
    },
    TIMEOUT,
  );

  it(
    'allows employees to fetch onboarding questions, validates answers, and exposes snapshot in owner insights',
    async () => {
      const owner = await createOnboardedUser({ email: `owner-${crypto.randomUUID().slice(0, 6)}@example.test` });
      const employee = await createOnboardedUser({ email: `emp-${crypto.randomUUID().slice(0, 6)}@example.test` });
      const admin = await createOnboardedUser({ role: 'admin' });

      // Create & approve org
      const orgRes = await json(
        await call('/organizations', {
          method: 'POST',
          headers: auth(owner.token),
          body: JSON.stringify({
            name: `GreenCorp ${crypto.randomUUID().slice(0, 6)}`,
            type: 'industry',
          }),
        }),
      );
      const orgId = orgRes.data.id;
      const orgCode = orgRes.data.code;

      await call(`/admin/organizations/${orgId}/review`, {
        method: 'POST',
        headers: auth(admin.token),
        body: JSON.stringify({
          decision: 'approve',
          note: 'Approved',
          expected: { name: orgRes.data.name, logoUrl: null, websiteUrl: null },
        }),
      });

      // Questions created
      const qTextRes = await json(
        await call(`/organizations/${orgId}/questions`, {
          method: 'POST',
          headers: auth(owner.token),
          body: JSON.stringify({
            prompt: 'Office Location',
            type: 'text',
            required: true,
          }),
        }),
      );
      const qTextId = qTextRes.data.id;

      const qChoiceRes = await json(
        await call(`/organizations/${orgId}/questions`, {
          method: 'POST',
          headers: auth(owner.token),
          body: JSON.stringify({
            prompt: 'Dietary Preference',
            type: 'single_choice',
            options: ['Omnivore', 'Vegetarian', 'Vegan'],
            required: true,
          }),
        }),
      );
      const qChoiceId = qChoiceRes.data.id;

      // Employee joins organization
      await call('/organizations/join', {
        method: 'POST',
        headers: auth(employee.token),
        body: JSON.stringify({ code: orgCode }),
      });

      // Employee queries /organizations/me/onboarding
      const empStatusRes = await json(
        await call('/organizations/me/onboarding', {
          method: 'GET',
          headers: auth(employee.token),
        }),
      );
      expect(empStatusRes.status).toBe(true);
      expect(empStatusRes.data.isCompleted).toBe(false);
      expect(empStatusRes.data.questions.length).toBe(2);

      // Submission validation: missing required field
      const missingRequiredRes = await json(
        await call('/organizations/me/onboarding', {
          method: 'POST',
          headers: auth(employee.token),
          body: JSON.stringify({
            answers: [{ questionId: qTextId, answer: 'San Francisco HQ' }],
          }),
        }),
      );
      expect(missingRequiredRes.status).toBe(false);
      expect(missingRequiredRes.error.code).toBe('ORG_016');

      // Submission validation: invalid option for single_choice
      const invalidOptionRes = await json(
        await call('/organizations/me/onboarding', {
          method: 'POST',
          headers: auth(employee.token),
          body: JSON.stringify({
            answers: [
              { questionId: qTextId, answer: 'San Francisco HQ' },
              { questionId: qChoiceId, answer: 'FastFoodOnly' },
            ],
          }),
        }),
      );
      expect(invalidOptionRes.status).toBe(false);
      expect(invalidOptionRes.error.code).toBe('ORG_017');

      // Valid submission
      const validSubmitRes = await json(
        await call('/organizations/me/onboarding', {
          method: 'POST',
          headers: auth(employee.token),
          body: JSON.stringify({
            answers: [
              { questionId: qTextId, answer: 'San Francisco HQ' },
              { questionId: qChoiceId, answer: 'Vegetarian' },
            ],
          }),
        }),
      );
      expect(validSubmitRes.status).toBe(true);
      expect(validSubmitRes.data.count).toBe(2);

      // Check onboarding completed
      const empStatusAfter = await json(
        await call('/organizations/me/onboarding', {
          method: 'GET',
          headers: auth(employee.token),
        }),
      );
      expect(empStatusAfter.data.isCompleted).toBe(true);

      // Owner updates question prompt: version increments to 2
      await call(`/organizations/${orgId}/questions/${qChoiceId}`, {
        method: 'PUT',
        headers: auth(owner.token),
        body: JSON.stringify({
          prompt: 'What is your primary diet?',
        }),
      });

      // Owner inspects employee answers via /organizations/{id}/members/{userId}/answers
      const memberAnswersRes = await json(
        await call(`/organizations/${orgId}/members/${employee.userId}/answers`, {
          method: 'GET',
          headers: auth(owner.token),
        }),
      );
      expect(memberAnswersRes.status).toBe(true);
      expect(memberAnswersRes.data.answers.length).toBe(2);

      const choiceAnswer = memberAnswersRes.data.answers.find(
        (a: { questionId: number }) => a.questionId === qChoiceId,
      );
      expect(choiceAnswer).toBeDefined();
      // Verifies immutable snapshot: original questionPrompt and version 1 are preserved!
      expect(choiceAnswer.questionPrompt).toBe('Dietary Preference');
      expect(choiceAnswer.questionVersion).toBe(1);
      expect(choiceAnswer.answer).toBe('Vegetarian');
    },
    TIMEOUT,
  );
});
