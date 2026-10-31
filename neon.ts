import { defineConfig } from '@neon/config/v1';

export default defineConfig({
  // Declare your Neon services here
  auth: false,
  buckets: {
    // User uploads: avatars and event covers ONLY.
    //
    // public_read because that is what the contract already assumes — the
    // presign response field is literally `publicUrl`, and an avatar is
    // rendered in every leaderboard row and public profile. A private bucket
    // would mean signing a fresh GET per row on every list render.
    //
    // The consequence, stated plainly: every object in this bucket is
    // readable by anyone who has its key. Keys are UUID-based and therefore
    // unguessable, but they are not secret. Anything that is not meant to be
    // seen by the public — a data export, an invoice — belongs in a second,
    // private bucket, not in here.
    uploads: { access: 'public_read' },
  },
  // Branch policy: per-branch tuning
  branch: (branch) => {
    if (branch.isDefault) {
      // Default branch: no overrides, uses project defaults
      return {};
    }
    if (!branch.exists) {
      // New non-default branches: auto-expire
      // Run `neon checkout <name>` to create a new branch with these settings
      return { ttl: '7d' };
    }
    // Existing branch: no changes
    return {};
  },
});
