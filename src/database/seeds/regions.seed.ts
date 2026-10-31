import { cities, regions } from '@database/schema/index.ts';
import { sql } from 'drizzle-orm';
import { insertAll, type Tx } from './support.ts';

/**
 * Reference data for onboarding question 2 (PRD-v2 §3.2, §7.7).
 *
 * `gridKgPerKwh` is what turns a user's kWh into kilograms, so it is the single
 * most load-bearing seeded number in the product.
 *
 * ONLY the 0.71 national average is sourced — CEA CO2 Baseline Database,
 * Appendix A. THE PER-STATE VALUES BELOW ARE PLAUSIBLE PLACEHOLDERS, NOT
 * PUBLISHED FIGURES: they are shaped by each state's generation mix (coal-heavy
 * eastern and central states above the average, hydro-heavy Himalayan states
 * and renewables-heavy southern states below it) and they average out near
 * 0.71. They need review against the CEA regional-grid tables before any public
 * launch, which is exactly what `factor_version` exists to make possible.
 *
 * `tariffPaisePerKwh` is a domestic slab rate, used only to convert a reported
 * monthly bill into kWh when the user does not know their consumption. Same
 * caveat: indicative, not tariff-order-accurate.
 */
const REGIONS: ReadonlyArray<[code: string, name: string, grid: number, tariff: number]> = [
  ['IN-AN', 'Andaman and Nicobar Islands', 0.68, 480],
  ['IN-AP', 'Andhra Pradesh', 0.72, 780],
  ['IN-AR', 'Arunachal Pradesh', 0.4, 520],
  ['IN-AS', 'Assam', 0.78, 700],
  ['IN-BR', 'Bihar', 0.88, 735],
  ['IN-CH', 'Chandigarh', 0.78, 450],
  ['IN-CT', 'Chhattisgarh', 0.95, 640],
  ['IN-DH', 'Dadra and Nagar Haveli and Daman and Diu', 0.7, 400],
  ['IN-DL', 'Delhi', 0.72, 800],
  ['IN-GA', 'Goa', 0.7, 420],
  ['IN-GJ', 'Gujarat', 0.68, 580],
  ['IN-HP', 'Himachal Pradesh', 0.36, 480],
  ['IN-HR', 'Haryana', 0.76, 720],
  ['IN-JH', 'Jharkhand', 0.92, 650],
  ['IN-JK', 'Jammu and Kashmir', 0.45, 540],
  ['IN-KA', 'Karnataka', 0.55, 790],
  ['IN-KL', 'Kerala', 0.38, 710],
  ['IN-LA', 'Ladakh', 0.5, 560],
  ['IN-LD', 'Lakshadweep', 0.72, 460],
  ['IN-MH', 'Maharashtra', 0.71, 950],
  ['IN-ML', 'Meghalaya', 0.42, 560],
  ['IN-MN', 'Manipur', 0.46, 540],
  ['IN-MP', 'Madhya Pradesh', 0.86, 680],
  ['IN-MZ', 'Mizoram', 0.44, 545],
  ['IN-NL', 'Nagaland', 0.47, 550],
  ['IN-OR', 'Odisha', 0.9, 620],
  ['IN-PB', 'Punjab', 0.74, 690],
  ['IN-PY', 'Puducherry', 0.6, 500],
  ['IN-RJ', 'Rajasthan', 0.64, 755],
  ['IN-SK', 'Sikkim', 0.34, 500],
  ['IN-TG', 'Telangana', 0.69, 760],
  ['IN-TN', 'Tamil Nadu', 0.58, 660],
  ['IN-TR', 'Tripura', 0.52, 575],
  ['IN-UP', 'Uttar Pradesh', 0.84, 710],
  ['IN-UT', 'Uttarakhand', 0.42, 560],
  ['IN-WB', 'West Bengal', 0.89, 745],
];

const CITIES: ReadonlyArray<[name: string, regionCode: string]> = [
  ['Mumbai', 'IN-MH'],
  ['Pune', 'IN-MH'],
  ['Nagpur', 'IN-MH'],
  ['Nashik', 'IN-MH'],
  ['Thane', 'IN-MH'],
  ['Delhi', 'IN-DL'],
  ['New Delhi', 'IN-DL'],
  ['Bengaluru', 'IN-KA'],
  ['Mysuru', 'IN-KA'],
  ['Hubballi', 'IN-KA'],
  ['Chennai', 'IN-TN'],
  ['Coimbatore', 'IN-TN'],
  ['Madurai', 'IN-TN'],
  ['Hyderabad', 'IN-TG'],
  ['Warangal', 'IN-TG'],
  ['Kolkata', 'IN-WB'],
  ['Howrah', 'IN-WB'],
  ['Siliguri', 'IN-WB'],
  ['Ahmedabad', 'IN-GJ'],
  ['Surat', 'IN-GJ'],
  ['Vadodara', 'IN-GJ'],
  ['Rajkot', 'IN-GJ'],
  ['Jaipur', 'IN-RJ'],
  ['Jodhpur', 'IN-RJ'],
  ['Udaipur', 'IN-RJ'],
  ['Lucknow', 'IN-UP'],
  ['Kanpur', 'IN-UP'],
  ['Varanasi', 'IN-UP'],
  ['Noida', 'IN-UP'],
  ['Agra', 'IN-UP'],
  ['Gurugram', 'IN-HR'],
  ['Faridabad', 'IN-HR'],
  ['Bhopal', 'IN-MP'],
  ['Indore', 'IN-MP'],
  ['Patna', 'IN-BR'],
  ['Kochi', 'IN-KL'],
  ['Thiruvananthapuram', 'IN-KL'],
  ['Kozhikode', 'IN-KL'],
  ['Visakhapatnam', 'IN-AP'],
  ['Vijayawada', 'IN-AP'],
  ['Chandigarh', 'IN-CH'],
  ['Bhubaneswar', 'IN-OR'],
  ['Guwahati', 'IN-AS'],
  ['Dehradun', 'IN-UT'],
  ['Shimla', 'IN-HP'],
  ['Amritsar', 'IN-PB'],
  ['Ludhiana', 'IN-PB'],
  ['Raipur', 'IN-CT'],
  ['Ranchi', 'IN-JH'],
  ['Panaji', 'IN-GA'],
  ['Puducherry', 'IN-PY'],
  ['Srinagar', 'IN-JK'],
];

export type RegionRow = {
  code: string;
  name: string;
  gridKgPerKwh: number;
  tariffPaisePerKwh: number;
};

/**
 * Upserts regions and rebuilds the city list.
 *
 * Regions are upserted rather than replaced because `cities.region_code`
 * references them. Cities are deleted and reinserted because nothing
 * references a city — `users.city` and `lifestyle_profiles.city` are plain
 * text — and there is no unique key on (name, region) to upsert against, so a
 * second run would otherwise duplicate all 52 rows.
 */
export async function seedRegions(tx: Tx): Promise<Map<string, RegionRow>> {
  const rows = REGIONS.map(([code, name, gridKgPerKwh, tariffPaisePerKwh]) => ({
    code,
    name,
    gridKgPerKwh,
    tariffPaisePerKwh,
  }));

  await tx
    .insert(regions)
    .values(rows)
    .onConflictDoUpdate({
      target: regions.code,
      // `excluded.<column>` is the value this statement tried to insert, so a
      // factor correction lands on a rerun instead of being skipped.
      set: {
        name: sql`excluded.name`,
        gridKgPerKwh: sql`excluded.grid_kg_per_kwh`,
        tariffPaisePerKwh: sql`excluded.tariff_paise_per_kwh`,
      },
    });

  await tx.delete(cities);
  await insertAll(
    CITIES.map(([name, regionCode]) => ({ name, regionCode })),
    (batch) => tx.insert(cities).values(batch),
  );

  return new Map(rows.map((r) => [r.code, r]));
}
