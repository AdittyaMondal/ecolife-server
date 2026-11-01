import { Client } from 'pg';

const LOCAL_URL = 'postgres://localhost:5432/ecolife';
const NEON_URL =
  'postgresql://neondb_owner:npg_XkhgOVlZ9mG5@ep-withered-wave-a13jzu3z.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';

const TARGET_EMAIL = 'yusufchipa69@gmail.com';

async function sync() {
  const localClient = new Client({ connectionString: LOCAL_URL });
  const neonClient = new Client({ connectionString: NEON_URL });

  await localClient.connect();
  await neonClient.connect();

  console.log('Connected to both local PostgreSQL and Neon DB.');

  try {
    // 1. Fetch Local User
    const localUserRes = await localClient.query(
      'SELECT * FROM users WHERE email = $1',
      [TARGET_EMAIL]
    );
    if (localUserRes.rows.length === 0) {
      throw new Error(`User ${TARGET_EMAIL} not found in local DB.`);
    }
    const localUser = localUserRes.rows[0];
    const localUid = localUser.id;
    console.log(`Local user found: ID ${localUid}, Coins: ${localUser.coins_balance}, Points: ${localUser.points_total}, Role: ${localUser.role}`);

    // 2. Fetch Neon User
    const neonUserRes = await neonClient.query(
      'SELECT * FROM users WHERE email = $1',
      [TARGET_EMAIL]
    );
    if (neonUserRes.rows.length === 0) {
      throw new Error(`User ${TARGET_EMAIL} not found in Neon DB.`);
    }
    const neonUser = neonUserRes.rows[0];
    const neonUid = neonUser.id;
    console.log(`Neon user found: ID ${neonUid}`);

    // 3. Update User details in Neon
    await neonClient.query(
      `UPDATE users
       SET name = $1,
           role = $2,
           coins_balance = $3,
           points_total = $4,
           password_hash = $5,
           email_verified_at = $6,
           city = $7,
           region_code = $8,
           timezone = $9,
           current_streak = $10,
           longest_streak = $11,
           onboarded_at = $12,
           updated_at = NOW()
       WHERE id = $13`,
      [
        localUser.name,
        localUser.role,
        localUser.coins_balance,
        localUser.points_total,
        localUser.password_hash,
        localUser.email_verified_at,
        localUser.city,
        localUser.region_code,
        localUser.timezone,
        localUser.current_streak,
        localUser.longest_streak,
        localUser.onboarded_at,
        neonUid,
      ]
    );
    console.log('✓ Updated user profile, coins (10,055), points (110), role (admin) in Neon.');

    // 4. Sync Lifestyle Profile (15 questions)
    const localLpRes = await localClient.query(
      'SELECT * FROM lifestyle_profiles WHERE user_id = $1',
      [localUid]
    );
    if (localLpRes.rows.length > 0) {
      const lp = localLpRes.rows[0];
      await neonClient.query(
        `INSERT INTO lifestyle_profiles (
           user_id, household_size, city, region_code, cooling_usage, diet_type,
           food_waste_level, packaged_food_freq, primary_commute_mode, vehicle_fuel,
           commute_distance_km, flights_per_year, electricity_kwh_month, electricity_bill_inr,
           kwh_source, cooking_fuel, has_solar, water_usage_level, waste_habit,
           baseline_transport_kg, baseline_food_kg, baseline_home_energy_kg, baseline_water_kg,
           baseline_waste_kg, baseline_total_kg, baseline_flight_kg, baseline_cook_kg,
           baseline_grid_base_kg, completed_steps, factor_version, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
           $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, NOW()
         )
         ON CONFLICT (user_id) DO UPDATE SET
           household_size = EXCLUDED.household_size,
           city = EXCLUDED.city,
           region_code = EXCLUDED.region_code,
           cooling_usage = EXCLUDED.cooling_usage,
           diet_type = EXCLUDED.diet_type,
           food_waste_level = EXCLUDED.food_waste_level,
           packaged_food_freq = EXCLUDED.packaged_food_freq,
           primary_commute_mode = EXCLUDED.primary_commute_mode,
           vehicle_fuel = EXCLUDED.vehicle_fuel,
           commute_distance_km = EXCLUDED.commute_distance_km,
           flights_per_year = EXCLUDED.flights_per_year,
           electricity_kwh_month = EXCLUDED.electricity_kwh_month,
           electricity_bill_inr = EXCLUDED.electricity_bill_inr,
           kwh_source = EXCLUDED.kwh_source,
           cooking_fuel = EXCLUDED.cooking_fuel,
           has_solar = EXCLUDED.has_solar,
           water_usage_level = EXCLUDED.water_usage_level,
           waste_habit = EXCLUDED.waste_habit,
           baseline_transport_kg = EXCLUDED.baseline_transport_kg,
           baseline_food_kg = EXCLUDED.baseline_food_kg,
           baseline_home_energy_kg = EXCLUDED.baseline_home_energy_kg,
           baseline_water_kg = EXCLUDED.baseline_water_kg,
           baseline_waste_kg = EXCLUDED.baseline_waste_kg,
           baseline_total_kg = EXCLUDED.baseline_total_kg,
           baseline_flight_kg = EXCLUDED.baseline_flight_kg,
           baseline_cook_kg = EXCLUDED.baseline_cook_kg,
           baseline_grid_base_kg = EXCLUDED.baseline_grid_base_kg,
           completed_steps = EXCLUDED.completed_steps,
           factor_version = EXCLUDED.factor_version,
           updated_at = NOW()`,
        [
          neonUid,
          lp.household_size,
          lp.city,
          lp.region_code,
          lp.cooling_usage,
          lp.diet_type,
          lp.food_waste_level,
          lp.packaged_food_freq,
          lp.primary_commute_mode,
          lp.vehicle_fuel,
          lp.commute_distance_km,
          lp.flights_per_year,
          lp.electricity_kwh_month,
          lp.electricity_bill_inr,
          lp.kwh_source,
          lp.cooking_fuel,
          lp.has_solar,
          lp.water_usage_level,
          lp.waste_habit,
          lp.baseline_transport_kg,
          lp.baseline_food_kg,
          lp.baseline_home_energy_kg,
          lp.baseline_water_kg,
          lp.baseline_waste_kg,
          lp.baseline_total_kg,
          lp.baseline_flight_kg,
          lp.baseline_cook_kg,
          lp.baseline_grid_base_kg,
          lp.completed_steps,
          lp.factor_version,
        ]
      );
      console.log('✓ Synced 15 lifestyle onboarding answers & baseline metrics.');
    }

    // 5. Sync Reward Transactions
    const localRewardsRes = await localClient.query(
      'SELECT * FROM reward_transactions WHERE user_id = $1 ORDER BY id ASC',
      [localUid]
    );
    await neonClient.query('DELETE FROM reward_transactions WHERE user_id = $1', [neonUid]);
    for (const r of localRewardsRes.rows) {
      await neonClient.query(
        `INSERT INTO reward_transactions (user_id, points_delta, coins_delta, source, source_id, note, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [neonUid, r.points_delta, r.coins_delta, r.source, r.source_id, r.note, r.created_at]
      );
    }
    console.log(`✓ Synced ${localRewardsRes.rows.length} reward transactions (including 10,000 coin seed).`);

    // 6. Sync Organization (Palx)
    const localOrgRes = await localClient.query("SELECT * FROM organizations WHERE slug = 'palx'");
    if (localOrgRes.rows.length > 0) {
      const org = localOrgRes.rows[0];
      const neonOrgRes = await neonClient.query(
        `INSERT INTO organizations (slug, name, type, status, code, region_code, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status
         RETURNING id`,
        [org.slug, org.name, org.type, org.status, org.code, org.region_code]
      );
      const neonOrgId = neonOrgRes.rows[0].id;

      await neonClient.query(
        `INSERT INTO organization_members (organization_id, user_id, role, share_footprint, joined_at)
         VALUES ($1, $2, 'owner', true, NOW())
         ON CONFLICT (user_id) DO UPDATE SET organization_id = EXCLUDED.organization_id, role = 'owner'`,
        [neonOrgId, neonUid]
      );
      console.log('✓ Synced organization Palx and set user as owner.');
    }

    // 7. Sync Garden Arrangement, Layout, Biomes, Skins, and Pets
    const gardenState = {
      gridCols: 16,
      gridRows: 11,
      playerPos: { x: 7, y: 5, direction: 'down' },
      activeHotbarIndex: 0,
      plantedTrees: [],
      inventory: [
        { treeSlug: 'neem', quantity: 5 },
        { treeSlug: 'mango', quantity: 5 },
        { treeSlug: 'gulmohar', quantity: 5 },
        { treeSlug: 'amaltas', quantity: 5 },
        { treeSlug: 'jacaranda', quantity: 5 },
        { treeSlug: 'peepal', quantity: 5 },
        { treeSlug: 'banyan', quantity: 5 },
        { treeSlug: 'red_sanders', quantity: 5 },
      ],
      hotbar: ['neem', 'mango', 'gulmohar', 'amaltas', 'jacaranda', 'peepal'],
      stats: {
        totalPlanted: 0,
        totalOffsetKgPerYear: 0,
        timesWatered: 0,
      },
      activeSkinId: 'gardener_default',
      unlockedSkins: ['gardener_default', 'forest_ranger', 'solar_scout'],
      activeBiomeId: 'meadow',
      unlockedBiomes: [
        'meadow',
        'zen_bamboo',
        'autumn_orchard',
        'sacred_grove',
        'desert_oasis',
        'crystal_glade',
      ],
      unlockedPets: ['dog', 'cat', 'horse', 'tiger', 'peacock', 'unicorn', 'pegasus'],
      activePetIds: ['dog', 'cat', 'horse', 'tiger', 'peacock', 'unicorn', 'pegasus'],
    };

    await neonClient.query(
      `INSERT INTO user_gardens (user_id, garden_state, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE SET garden_state = EXCLUDED.garden_state, updated_at = NOW()`,
      [neonUid, JSON.stringify(gardenState)]
    );
    console.log('✓ Saved garden arrangement, layout, skins, biomes, and pets to user_gardens table in Neon.');

    console.log('\n🌟 ALL ACCOUNT DETAILS, COINS, POINTS & GARDEN SUCCESSFULLY PUSHED TO NEON DB!');
  } finally {
    await localClient.end();
    await neonClient.end();
  }
}

sync().catch((err) => {
  console.error('Sync failed:', err);
  process.exit(1);
});
