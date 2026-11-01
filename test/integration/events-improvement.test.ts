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

describe('Events Improvement (Part 5)', () => {
  it(
    'supports partner event creation with venue map link, organization-only visibility, and role-based access',
    async () => {
      const partnerOwner = await createOnboardedUser({
        email: `partner-${crypto.randomUUID().slice(0, 6)}@example.test`,
      });
      const orgMemberEmail = `orgmem-${crypto.randomUUID().slice(0, 6)}@example.test`;
      const orgMember = await createOnboardedUser({
        email: orgMemberEmail,
      });
      const outsider = await createOnboardedUser({
        email: `outsider-${crypto.randomUUID().slice(0, 6)}@example.test`,
      });
      const admin = await createOnboardedUser({ role: 'admin' });

      // 1. Create and approve Corporate Partner Organization
      const orgRes = await json(
        await call('/organizations', {
          method: 'POST',
          headers: auth(partnerOwner.token),
          body: JSON.stringify({
            name: `AeroSpace ESG ${crypto.randomUUID().slice(0, 6)}`,
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
          note: 'Approved for event test',
          expected: { name: orgRes.data.name, logoUrl: null, websiteUrl: null },
        }),
      });

      // Member joins organization
      await call('/organizations/join', {
        method: 'POST',
        headers: auth(orgMember.token),
        body: JSON.stringify({ code: orgCode }),
      });

      // 2. Partner Owner creates an organization-only event
      const startAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
      const endAt = new Date(Date.now() + 2 * 86_400_000 + 4 * 3_600_000).toISOString();

      const createEventRes = await json(
        await call('/events', {
          method: 'POST',
          headers: auth(partnerOwner.token),
          body: JSON.stringify({
            title: `Campus Tree Plantation ${crypto.randomUUID().slice(0, 4)}`,
            description: 'Exclusive corporate sustainability drive for verified employees.',
            type: 'plant_drive',
            visibility: 'organization_only',
            organizationId: orgId,
            startAt,
            endAt,
            venueName: 'AeroSpace Innovation Center',
            venueAddress: 'Sector 42, Tech Corridor',
            venueMapUrl: 'https://maps.google.com/?q=AeroSpace+Innovation+Center',
            capacity: 2,
            publish: true,
          }),
        }),
      );

      expect(createEventRes.status).toBe(true);
      expect(createEventRes.data.organizationId).toBe(orgId);
      expect(createEventRes.data.visibility).toBe('organization_only');
      expect(createEventRes.data.venueMapUrl).toBe(
        'https://maps.google.com/?q=AeroSpace+Innovation+Center',
      );
      const eventId = createEventRes.data.id;
      const eventSlug = createEventRes.data.slug;

      // 3. Access guard: Outsider cannot view or register for organization_only event
      const outsiderViewRes = await json(
        await call(`/events/${eventSlug}`, {
          method: 'GET',
          headers: auth(outsider.token),
        }),
      );
      expect(outsiderViewRes.status).toBe(false);
      expect(outsiderViewRes.error.code).toBe('EVENT_012');

      const outsiderRegRes = await json(
        await call(`/events/${eventId}/register`, {
          method: 'POST',
          headers: auth(outsider.token),
        }),
      );
      expect(outsiderRegRes.status).toBe(false);
      expect(outsiderRegRes.error.code).toBe('EVENT_012');

      // 4. Organization member can view and register
      const memberViewRes = await json(
        await call(`/events/${eventSlug}`, {
          method: 'GET',
          headers: auth(orgMember.token),
        }),
      );
      expect(memberViewRes.status).toBe(true);
      expect(memberViewRes.data.title).toBe(createEventRes.data.title);

      const memberRegRes = await json(
        await call(`/events/${eventId}/register`, {
          method: 'POST',
          headers: auth(orgMember.token),
        }),
      );
      expect(memberRegRes.status).toBe(true);
      expect(memberRegRes.data.pass.status).toBe('registered');
      expect(memberRegRes.data.event.registeredCount).toBe(1);

      // 5. Member leaves event
      const unregRes = await json(
        await call(`/events/${eventId}/register`, {
          method: 'DELETE',
          headers: auth(orgMember.token),
        }),
      );
      expect(unregRes.status).toBe(true);
      expect(unregRes.data.cancelled).toBe(true);

      // Check registered count decremented
      const eventAfterLeave = await json(
        await call(`/events/${eventSlug}`, {
          method: 'GET',
          headers: auth(orgMember.token),
        }),
      );
      expect(eventAfterLeave.data.registeredCount).toBe(0);

      // Re-register to have a participant for organizer testing
      await call(`/events/${eventId}/register`, {
        method: 'POST',
        headers: auth(orgMember.token),
      });

      // 6. Organizer management: Edit event
      const updateRes = await json(
        await call(`/events/${eventId}`, {
          method: 'PATCH',
          headers: auth(partnerOwner.token),
          body: JSON.stringify({
            venueName: 'AeroSpace Green Campus Quad',
            venueMapUrl: 'https://maps.google.com/?q=Quad',
          }),
        }),
      );
      expect(updateRes.status).toBe(true);
      expect(updateRes.data.venueName).toBe('AeroSpace Green Campus Quad');

      // 7. Organizer views participant list
      const participantsRes = await json(
        await call(`/events/${eventId}/participants`, {
          method: 'GET',
          headers: auth(partnerOwner.token),
        }),
      );
      expect(participantsRes.status).toBe(true);
      expect(participantsRes.data.registeredCount).toBe(1);
      expect(participantsRes.data.items.length).toBe(1);
      expect(participantsRes.data.items[0].email).toBe(orgMemberEmail);

      // 8. Organizer exports participants CSV
      const exportRes = await call(`/events/${eventId}/participants/export`, {
        method: 'GET',
        headers: auth(partnerOwner.token),
      });
      expect(exportRes.status).toBe(200);
      expect(exportRes.headers.get('content-type')).toContain('text/csv');
      const csvText = await exportRes.text();
      expect(csvText).toContain('Pass ID,User ID,Name,Email,Status');
      expect(csvText).toContain(orgMemberEmail);

      // 9. Organizer cancels event
      const cancelRes = await json(
        await call(`/events/${eventId}/cancel`, {
          method: 'POST',
          headers: auth(partnerOwner.token),
        }),
      );
      expect(cancelRes.status).toBe(true);
      expect(cancelRes.data.status).toBe('cancelled');
    },
    TIMEOUT,
  );

  it(
    'supports search and organization-level event filtering',
    async () => {
      const host = await createOnboardedUser({
        email: `searchhost-${crypto.randomUUID().slice(0, 6)}@example.test`,
      });

      const uniqueKeyword = `VersovaEco${crypto.randomUUID().slice(0, 4)}`;
      const startAt = new Date(Date.now() + 86_400_000).toISOString();
      const endAt = new Date(Date.now() + 86_400_000 + 7_200_000).toISOString();

      await json(
        await call('/events', {
          method: 'POST',
          headers: auth(host.token),
          body: JSON.stringify({
            title: `Beach Drive ${uniqueKeyword}`,
            description: 'Public community cleanup event along the coastal strip.',
            type: 'cleanup_drive',
            visibility: 'public',
            startAt,
            endAt,
            venueName: 'Marine Promenade',
            capacity: 50,
            publish: true,
          }),
        }),
      );

      // Search by keyword
      const searchRes = await json(
        await call(`/events?search=${uniqueKeyword}`, {
          method: 'GET',
          headers: auth(host.token),
        }),
      );
      expect(searchRes.status).toBe(true);
      expect(searchRes.data.items.length).toBeGreaterThanOrEqual(1);
      expect(searchRes.data.items[0].title).toContain(uniqueKeyword);
    },
    TIMEOUT,
  );
});
